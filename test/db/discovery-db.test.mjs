/**
 * discovery.db — the separate music-discovery dataset (src/db/discovery-db.js)
 * and its export-snapshot builder (src/db/discovery-export.js).
 *
 * Asserts:
 *   1. Bootstrap: schema v1 tables, WAL, meta seeding (monotonic row_seq
 *      counter, secret export_salt, embedding format contract keys).
 *   2. Idempotent re-open: export_salt / created_at survive a close+reopen
 *      (a rotating salt would silently break anon export-id stability).
 *   3. exportIdFor: mbid-preferred, salted-anon fallback, deterministic.
 *   4. upsertDiscoveryTrack: insert + replace semantics, monotonic
 *      updated_at bumps, embedding BLOB round-trip.
 *   5. Export snapshot: explicit column/meta allowlist (no audio_hash, no
 *      source_mtime, no updated_at, no discovery_lookups, no export_salt,
 *      no row_seq), deterministic ordering, manifest sha256/row-count
 *      integrity, rebuild-overwrite.
 *
 * These run in-process against a temp directory — no server, no config
 * (both modules take explicit paths for exactly this use, mirroring how the
 * future forked embedding worker will receive paths via its JSON payload).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  initDiscoveryDb, closeDiscoveryDb, isDiscoveryDbOpen, getDiscoveryDb,
  upsertDiscoveryTrack, exportIdFor, getMeta, setMeta,
  applyHashTransitionGroups,
  DISCOVERY_SCHEMA_VERSION, EMBEDDING_DTYPE, EMBEDDING_NORMALIZATION,
} from '../../src/db/discovery-db.js';
import {
  exportDiscoverySnapshot, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_VERSION,
} from '../../src/db/discovery-export.js';

let tmpDir;
let dbPath;
let outDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-discovery-test-'));
  dbPath = path.join(tmpDir, 'discovery.db');
  outDir = path.join(tmpDir, 'export');
});

after(() => {
  closeDiscoveryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function embeddingBlob(floats) {
  return Buffer.from(new Float32Array(floats).buffer);
}

function blobToFloats(blob) {
  const u8 = Uint8Array.from(blob);
  return Array.from(new Float32Array(u8.buffer, 0, u8.byteLength / 4));
}

describe('discovery-db bootstrap', () => {
  test('initDiscoveryDb creates the schema at the current version', () => {
    assert.equal(isDiscoveryDbOpen(), false);
    initDiscoveryDb(dbPath);
    assert.equal(isDiscoveryDbOpen(), true);
    assert.ok(fs.existsSync(dbPath), 'discovery.db file created');

    const db = getDiscoveryDb();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,
      DISCOVERY_SCHEMA_VERSION);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(tables, ['discovery_lookups', 'discovery_meta', 'discovery_tracks']);
  });

  test('meta is seeded: counter, secret salt, embedding format contract', () => {
    assert.equal(getMeta('row_seq'), '0');
    assert.match(getMeta('export_salt'), /^[0-9a-f]{64}$/);
    assert.ok(getMeta('created_at'));
    assert.equal(getMeta('embedding_dtype'), EMBEDDING_DTYPE);
    assert.equal(getMeta('embedding_normalization'), EMBEDDING_NORMALIZATION);
    // The model pin is written by the embedding worker, not at bootstrap —
    // an empty store must not claim a model it never ran.
    assert.equal(getMeta('embedding_model_id'), null);
  });

  test('re-open is idempotent — salt and created_at survive', () => {
    const salt = getMeta('export_salt');
    const created = getMeta('created_at');
    closeDiscoveryDb();
    assert.equal(isDiscoveryDbOpen(), false);
    initDiscoveryDb(dbPath);
    assert.equal(getMeta('export_salt'), salt, 'export_salt must never rotate');
    assert.equal(getMeta('created_at'), created);
  });
});

describe('exportIdFor', () => {
  test('prefers the MusicBrainz recording MBID, lowercased', () => {
    assert.equal(
      exportIdFor('B1A9C0E9-D987-4042-AE91-78D6A3267D69', 'hash-a'),
      'mbid:b1a9c0e9-d987-4042-ae91-78d6a3267d69');
  });

  test('falls back to a deterministic salted anon id', () => {
    const a1 = exportIdFor(null, 'hash-a');
    const a2 = exportIdFor(null, 'hash-a');
    const b  = exportIdFor(null, 'hash-b');
    assert.match(a1, /^anon:[0-9a-f]{32}$/);
    assert.equal(a1, a2, 'deterministic for the same hash');
    assert.notEqual(a1, b);
    // Salted — the raw hash must not be recoverable by hashing it unsalted.
    assert.notEqual(a1.slice(5), sha256('hash-a').slice(0, 32));
  });
});

describe('upsertDiscoveryTrack', () => {
  test('insert populates export_id and a monotonic updated_at', () => {
    upsertDiscoveryTrack({
      audioHash: 'hash-1',
      artist: 'Artist A', title: 'Song 1', duration: 123.4,
      embedding: embeddingBlob([0.5, -0.25, 0.125]),
      modelId: 'test-model', modelVersion: '1',
      bpm: 120, musicalKey: 'C major', danceability: 0.7,
      genreTags: ['rock'], moodTags: ['happy'],
      sourceMtime: 111,
    });
    const row = getDiscoveryDb()
      .prepare('SELECT * FROM discovery_tracks WHERE audio_hash = ?').get('hash-1');
    assert.equal(row.updated_at, 1);
    assert.match(row.export_id, /^anon:/);
    assert.equal(row.artist, 'Artist A');
    assert.deepEqual(JSON.parse(row.genre_tags), ['rock']);
    assert.deepEqual(blobToFloats(row.embedding), [0.5, -0.25, 0.125]);
    assert.ok(row.analyzed_at > 0);
  });

  test('re-upsert replaces values and bumps updated_at; MBID flips export_id', () => {
    upsertDiscoveryTrack({
      audioHash: 'hash-1',
      recordingMbid: 'ABC-123',
      artist: 'Artist A', title: 'Song 1 (fixed tags)',
    });
    const rows = getDiscoveryDb()
      .prepare('SELECT * FROM discovery_tracks WHERE audio_hash = ?').all('hash-1');
    assert.equal(rows.length, 1, 'upsert must not duplicate the row');
    assert.equal(rows[0].updated_at, 2, 'rowversion bumps on every write');
    assert.equal(rows[0].export_id, 'mbid:abc-123');
    assert.equal(rows[0].title, 'Song 1 (fixed tags)');
    assert.equal(getMeta('row_seq'), '2');
  });

  test('audioHash is required', () => {
    assert.throws(() => upsertDiscoveryTrack({ artist: 'X' }), /audioHash/);
  });
});

describe('export snapshot', () => {
  before(() => {
    // Rows whose insert order differs from export_id order, to prove the
    // deterministic ORDER BY. hash-1 (mbid:abc-123) already exists.
    upsertDiscoveryTrack({ audioHash: 'hash-2', artist: 'Zed', title: 'Last' });
    upsertDiscoveryTrack({
      audioHash: 'hash-3', recordingMbid: '000-first',
      artist: 'Aardvark', title: 'First',
      embedding: embeddingBlob([1, 0, 0, 0]),
    });
    // Negative-cache noise that must never travel.
    getDiscoveryDb().prepare(
      'INSERT INTO discovery_lookups (audio_hash, last_attempt_at, outcome) VALUES (?, ?, ?)'
    ).run('hash-err', Date.now(), 'error');
  });

  test('builds a cleaned snapshot + integrity manifest', async () => {
    const manifest = await exportDiscoverySnapshot({ outDir });

    assert.equal(manifest.format, SNAPSHOT_FORMAT);
    assert.equal(manifest.formatVersion, SNAPSHOT_FORMAT_VERSION);
    assert.equal(manifest.sourceSchemaVersion, DISCOVERY_SCHEMA_VERSION);
    assert.equal(manifest.rowCount, 3);
    assert.equal(manifest.model.dtype, EMBEDDING_DTYPE);
    assert.equal(manifest.model.normalization, EMBEDDING_NORMALIZATION);
    assert.equal(manifest.model.id, null, 'no model pinned yet');

    const snapshotFile = path.join(outDir, 'discovery-export.db');
    const bytes = fs.readFileSync(snapshotFile);
    assert.equal(bytes.length, manifest.sizeBytes);
    assert.equal(sha256(bytes), manifest.sha256);
    assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'README.md')));
    assert.ok(!fs.existsSync(`${snapshotFile}.building`), 'temp build file cleaned up');
  });

  test('snapshot carries ONLY the share-safe surface', () => {
    const snap = new DatabaseSync(path.join(outDir, 'discovery-export.db'), { readOnly: true });
    try {
      assert.equal(snap.prepare('PRAGMA user_version').get().user_version,
        SNAPSHOT_FORMAT_VERSION);

      const tables = snap.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map(r => r.name);
      assert.deepEqual(tables, ['meta', 'tracks'], 'no internal tables travel');

      const cols = snap.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
      assert.deepEqual(cols, [
        'export_id', 'recording_mbid', 'acoustid_id', 'artist', 'title',
        'duration', 'model_id', 'model_version', 'embedding', 'bpm',
        'musical_key', 'danceability', 'genre_tags', 'mood_tags',
      ], 'internal columns (audio_hash / source_mtime / updated_at) must not travel');

      const metaKeys = snap.prepare('SELECT key FROM meta ORDER BY key').all().map(r => r.key);
      assert.ok(!metaKeys.includes('export_salt'), 'the salt is a secret');
      assert.ok(!metaKeys.includes('row_seq'));
      assert.ok(metaKeys.includes('embedding_dtype'));
      assert.ok(metaKeys.includes('format'));
      assert.ok(metaKeys.includes('row_count'));

      // Deterministic ordering by export_id (mbid:… sorts before anon:…
      // is NOT assumed — just assert sorted order).
      const ids = snap.prepare('SELECT export_id FROM tracks').all().map(r => r.export_id);
      assert.deepEqual(ids, [...ids].sort(), 'rows ordered by export_id');
      assert.equal(ids.length, 3);
      assert.ok(ids.includes('mbid:abc-123'));
      assert.ok(ids.includes('mbid:000-first'));

      // Embedding BLOB round-trips through the snapshot bit-exactly.
      const emb = snap.prepare(
        "SELECT embedding FROM tracks WHERE export_id = 'mbid:000-first'").get().embedding;
      assert.deepEqual(blobToFloats(emb), [1, 0, 0, 0]);
    } finally {
      snap.close();
    }
  });

  test('rebuild overwrites the previous snapshot', async () => {
    const first = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    upsertDiscoveryTrack({ audioHash: 'hash-4', artist: 'New', title: 'Row' });
    const manifest = await exportDiscoverySnapshot({ outDir });
    assert.equal(manifest.rowCount, 4);
    assert.notEqual(manifest.sha256, first.sha256);
    const bytes = fs.readFileSync(path.join(outDir, 'discovery-export.db'));
    assert.equal(sha256(bytes), manifest.sha256);
  });

  test('model pin in discovery_meta lands in the manifest', async () => {
    setMeta('embedding_model_id', 'laion-clap');
    setMeta('embedding_model_version', '2026-test');
    setMeta('embedding_dim', '512');
    const manifest = await exportDiscoverySnapshot({ outDir });
    assert.deepEqual(manifest.model, {
      id: 'laion-clap', version: '2026-test', dim: 512,
      dtype: EMBEDDING_DTYPE, normalization: EMBEDDING_NORMALIZATION,
    });
    const snap = new DatabaseSync(path.join(outDir, 'discovery-export.db'), { readOnly: true });
    try {
      const model = snap.prepare(
        "SELECT value FROM meta WHERE key = 'embedding_model_id'").get();
      assert.equal(model.value, 'laion-clap');
    } finally {
      snap.close();
    }
  });
});

describe('applyHashTransitionGroups', () => {
  // Uses the suite's shared open DB; hashes here are namespaced 'rk-*'
  // so they can't collide with the other describes' rows.
  test('moving a row re-derives export_id and bumps the rowversion', () => {
    upsertDiscoveryTrack({ audioHash: 'rk-old', artist: 'A', embedding: embeddingBlob([1, 2]) });
    const before = getDiscoveryDb().prepare(
      'SELECT export_id, updated_at FROM discovery_tracks WHERE audio_hash = ?').get('rk-old');

    const out = applyHashTransitionGroups([{ target: 'rk-new', sources: ['rk-old'] }]);
    assert.deepEqual(out, { moved: 1, dropped: 0 });

    const row = getDiscoveryDb().prepare(
      `SELECT export_id, updated_at, embedding FROM discovery_tracks
        WHERE audio_hash = ?`).get('rk-new');
    assert.ok(row, 'row moved to the new identity');
    assert.equal(row.export_id, exportIdFor(null, 'rk-new'),
      'anon export_id re-derived from the NEW hash — a raw UPDATE would leave the old one');
    assert.notEqual(row.export_id, before.export_id);
    assert.ok(row.updated_at > before.updated_at, 'rowversion bumped for incremental consumers');
    assert.deepEqual(blobToFloats(row.embedding), [1, 2], 'payload travels intact');
  });

  test('a row already at the target wins; sources are dropped, not applied over it', () => {
    upsertDiscoveryTrack({ audioHash: 'rk-t', artist: 'target-fresh' });
    upsertDiscoveryTrack({ audioHash: 'rk-s1', artist: 'stale' });
    const out = applyHashTransitionGroups([{ target: 'rk-t', sources: ['rk-s1'] }]);
    assert.deepEqual(out, { moved: 0, dropped: 1 });
    const rows = getDiscoveryDb().prepare(
      "SELECT audio_hash, artist FROM discovery_tracks WHERE audio_hash LIKE 'rk-%' AND audio_hash IN ('rk-t','rk-s1')").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ audio_hash: 'rk-t', artist: 'target-fresh' }]);
  });

  test('several sources collapsing to one terminal: the freshest wins regardless of order', () => {
    upsertDiscoveryTrack({ audioHash: 'rk-a', artist: 'older' });   // lower rowversion
    upsertDiscoveryTrack({ audioHash: 'rk-b', artist: 'newer' });   // higher rowversion
    // Sources listed stale-last to prove order doesn't decide.
    const out = applyHashTransitionGroups([{ target: 'rk-c', sources: ['rk-b', 'rk-a'] }]);
    assert.deepEqual(out, { moved: 1, dropped: 1 });
    const c = getDiscoveryDb().prepare(
      'SELECT artist FROM discovery_tracks WHERE audio_hash = ?').get('rk-c');
    assert.equal(c.artist, 'newer');
    const gone = getDiscoveryDb().prepare(
      "SELECT COUNT(*) AS n FROM discovery_tracks WHERE audio_hash IN ('rk-a','rk-b')").get();
    assert.equal(gone.n, 0);
  });

  test('discovery_lookups follow the same policy keyed on last_attempt_at', () => {
    const ddb = getDiscoveryDb();
    ddb.prepare(`INSERT INTO discovery_lookups (audio_hash, last_attempt_at, outcome)
                 VALUES ('rk-l1', 100, 'error'), ('rk-l2', 200, 'nomatch')`).run();
    applyHashTransitionGroups([{ target: 'rk-l3', sources: ['rk-l1', 'rk-l2'] }]);
    const rows = ddb.prepare(
      "SELECT audio_hash, outcome FROM discovery_lookups WHERE audio_hash LIKE 'rk-l%'").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ audio_hash: 'rk-l3', outcome: 'nomatch' }]);
  });
});
