/**
 * Unit tests for src/db/enrichment-status-lib.js — the durable coverage
 * counts behind GET /api/v1/scan/status.
 *
 * The counting rules are the contract here: each pass's `remaining` must
 * mirror its worker's eligibility predicate (duration windows, NULL
 * gates, hashless exclusion), `done` counts the artifact regardless of
 * which writer produced it, library filtering must scope track/album
 * passes to the caller's accessible libraries while hash-keyed passes
 * (waveform, discovery) stay global, and ledger outcome maps must only
 * count hashes that still resolve to an accessible track. All of that is
 * pinned against a hand-seeded DB where every expected number is
 * derivable by eye from the seed block.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot;
let config;
let dbManager;
let discoveryDb;
let coverageLib;
let L1;
let L2;

// Seeded expectations reference these — see the before() block.
const NOW_SEC = Math.floor(Date.now() / 1000);

before(async () => {
  testRoot = path.join(os.tmpdir(), `mstream-enrich-cov-${Date.now()}`);
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.mkdirSync(path.join(testRoot, 'waveforms'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  discoveryDb = await import('../../src/db/discovery-db.js');
  coverageLib = await import('../../src/db/enrichment-status-lib.js');

  const d = dbManager.getDB();

  d.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('lib1', ?, 'music', 0)`)
    .run(path.join(testRoot, 'lib1'));
  d.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('lib2', ?, 'music', 0)`)
    .run(path.join(testRoot, 'lib2'));
  dbManager.invalidateCache();
  L1 = dbManager.getLibraryByName('lib1').id;
  L2 = dbManager.getLibraryByName('lib2').id;

  const artistId = Number(d.prepare(`INSERT INTO artists (name) VALUES ('Seeder')`).run().lastInsertRowid);

  // Albums: AL1 has art, AL2 lacks it, AL3 lives in lib2 only, AL4 is
  // blank-named (excluded from the downloader's pool), AL5 is a ghost
  // with no tracks (also excluded).
  const album = (name, art) => Number(
    d.prepare('INSERT INTO albums (name, album_art_file) VALUES (?, ?)').run(name, art).lastInsertRowid);
  const AL1 = album('With Art', 'cover1.jpg');
  const AL2 = album('No Art', null);
  const AL3 = album('Other Lib', null);
  const AL4 = album('   ', null);
  album('Ghost — no tracks', null);

  // Tracks. The per-pass expectations, by eye:
  //   T1 fully enriched: lyrics, bpm+key, tag MBID, in-window duration.
  //   T2 enriched by nothing: the one in-window remaining for every pass.
  //   T3 hashless + 5s: structurally ineligible everywhere.
  //   T4 4000s (outside the 30min analysis window, inside acoustid's 2h),
  //      artist-less (lyrics-ineligible), bpm-only (analysis not done).
  //   T5 in lib2: acoustid-sourced MBID; invisible to lib1-scoped counts.
  const insTrack = d.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, duration,
                        file_hash, audio_hash, bpm, musical_key,
                        lyrics_embedded, lyrics_synced_lrc, mbz_recording_id, mbz_id_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insTrack.run('t1.mp3', L1, 'Song1', artistId, AL1, 200, 'f1', 'h1', 120, '8A', 'la la', null, 'mbid-1', 'tag');
  insTrack.run('t2.mp3', L1, 'Song2', artistId, AL2, 200, 'f2', 'h2', null, null, null, null, null, null);
  insTrack.run('t3.mp3', L1, null, null, AL4, 5, null, null, null, null, null, null, null, null);
  insTrack.run('t4.mp3', L1, 'Song4', null, null, 4000, 'f4', 'h4', 100, null, null, null, null, null);
  insTrack.run('t5.mp3', L2, 'Other', artistId, AL3, 200, 'f5', 'h5', null, null, null, null, 'mbid-5', 'acoustid');

  // Attempt ledgers. The lib2-scoped album_art error row and the orphan
  // lyrics_cache hit must be filtered out of lib1-scoped outcome maps.
  d.prepare(`INSERT INTO album_art_lookups (album_id, last_attempt_at, outcome) VALUES (?, ?, 'notfound')`)
    .run(AL2, NOW_SEC);
  d.prepare(`INSERT INTO album_art_lookups (album_id, last_attempt_at, outcome) VALUES (?, ?, 'error')`)
    .run(AL3, NOW_SEC);
  d.prepare(`INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome) VALUES ('h2', ?, 'error')`)
    .run(NOW_SEC);
  d.prepare(`INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome) VALUES ('h2', ?, 'nomatch')`)
    .run(NOW_SEC);
  d.prepare(`INSERT INTO lyrics_cache (audio_hash, status, fetched_at) VALUES ('h2', 'notfound', ?)`)
    .run(Date.now());
  d.prepare(`INSERT INTO lyrics_cache (audio_hash, status, fetched_at) VALUES ('h-orphan', 'hit', ?)`)
    .run(Date.now());

  // Waveform cache artifacts: 2 bins + 1 failed marker; the .bin.tmp is
  // an in-flight temp file the counter must ignore. Global hash pool is
  // h1/h2/h4/h5 (T3 is hashless) → remaining = 4 − 2 − 1 = 1.
  const wf = config.program.storage.waveformCacheDirectory;
  fs.writeFileSync(path.join(wf, 'h1.bin'), Buffer.alloc(8));
  fs.writeFileSync(path.join(wf, 'h2.bin'), Buffer.alloc(8));
  fs.writeFileSync(path.join(wf, 'h4.failed'), '');
  fs.writeFileSync(path.join(wf, 'h5.bin.tmp'), Buffer.alloc(8));

  // Discovery: h1 embedded under the CURRENT model → done. h5 embedded
  // under a stale model → still remaining (the worker re-embeds it).
  // In-window hashes lacking a current-model embedding: h2, h5 → 2.
  const ddb = discoveryDb.initDiscoveryDb();
  const model = config.program.scanOptions.discoveryModel;
  const insEmb = ddb.prepare(`
    INSERT INTO discovery_tracks (audio_hash, updated_at, export_id, model_id, embedding)
    VALUES (?, ?, ?, ?, ?)`);
  insEmb.run('h1', 1, 'anon:h1', model, Buffer.alloc(16));
  insEmb.run('h5', 2, 'anon:h5', 'legacy-model', Buffer.alloc(16));
  ddb.prepare(`INSERT INTO discovery_lookups (audio_hash, last_attempt_at, outcome) VALUES ('h2', ?, 'error')`)
    .run(NOW_SEC);
});

after(() => {
  if (discoveryDb) { discoveryDb.closeDiscoveryDb(); }
  if (dbManager) { dbManager.close(); }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  // Repo convention for suites that boot the real DB: without this the
  // SQLite handle keeps the test runner alive.
  setImmediate(() => process.exit(0));
});

function coverage(libIds) {
  return coverageLib.getEnrichmentCoverage(libIds, { force: true });
}

describe('enrichment coverage: lib1-scoped counts', () => {
  test('totals count only accessible tracks', () => {
    assert.equal(coverage([L1]).totals.tracks, 4);
  });

  test('albumart: named albums with accessible tracks; done = has art', () => {
    const c = coverage([L1]).passes.albumart;
    assert.equal(c.scope, 'library');
    assert.equal(c.eligible, 2, 'AL1 + AL2 (blank-named, trackless, lib2-only excluded)');
    assert.equal(c.done, 1);
    assert.equal(c.remaining, 1);
    assert.deepEqual(c.outcomes, { notfound: 1 }, "lib2's error row must not leak in");
  });

  test('lyrics: done = has lyrics; remaining = lyric-less AND lookup-able', () => {
    const c = coverage([L1]).passes.lyrics;
    assert.equal(c.done, 1, 'T1');
    assert.equal(c.remaining, 1, 'T2 only — T3 lacks a title, T4 lacks an artist');
    assert.deepEqual(c.outcomes, { notfound: 1 }, 'orphan-hash cache rows must not count');
  });

  test('audioanalysis: done needs BOTH bpm and key; remaining honours the duration window', () => {
    const c = coverage([L1]).passes.audioanalysis;
    assert.equal(c.done, 1, 'T1 — T4 has bpm but no key');
    assert.equal(c.remaining, 1, 'T2 only — T4 is outside the 30min window, T3 is hashless');
    assert.deepEqual(c.outcomes, { error: 1 });
  });

  test('acoustid: done split by provenance; remaining honours its wider window', () => {
    const c = coverage([L1]).passes.acoustid;
    assert.equal(c.done, 1);
    assert.deepEqual(c.bySource, { tag: 1, acoustid: 0 }, 'T5 is lib2-only');
    assert.equal(c.remaining, 2, 'T2 and T4 (4000s fits the 2h acoustid window)');
    assert.deepEqual(c.outcomes, { nomatch: 1 });
  });

  test('waveform: global artifact counts; temp files ignored', () => {
    const c = coverage([L1]).passes.waveform;
    assert.equal(c.scope, 'global');
    assert.equal(c.done, 2, 'h1.bin + h2.bin — the .bin.tmp must not count');
    assert.equal(c.remaining, 1, '4 global hashes − 2 bins − 1 failed');
    assert.deepEqual(c.outcomes, { failed: 1 });
  });

  test('discovery: current-model embeddings only; stale-model rows stay remaining', () => {
    const c = coverage([L1]).passes.discovery;
    assert.equal(c.scope, 'global');
    assert.equal(c.model, config.program.scanOptions.discoveryModel);
    assert.equal(c.done, 1, 'h1 — the legacy-model h5 row does not count');
    assert.equal(c.remaining, 2, 'h2 + h5 (h4 is outside the duration window)');
    assert.deepEqual(c.outcomes, { error: 1 });
  });
});

describe('enrichment coverage: scope and caching', () => {
  test('widening access to both libraries widens the counts', () => {
    const c = coverage([L1, L2]);
    assert.equal(c.totals.tracks, 5);
    assert.equal(c.passes.albumart.eligible, 3);
    assert.deepEqual(c.passes.albumart.outcomes, { notfound: 1, error: 1 });
    assert.deepEqual(c.passes.acoustid.bySource, { tag: 1, acoustid: 1 });
  });

  test('empty library access zeroes the library-scoped counts', () => {
    const c = coverage([]);
    assert.equal(c.totals.tracks, 0);
    assert.equal(c.passes.albumart.eligible, 0);
    assert.equal(c.passes.lyrics.remaining, 0);
    // Hash-keyed passes are global on purpose.
    assert.equal(c.passes.waveform.done, 2);
  });

  test('results are memoised per library set until forced', () => {
    const first = coverage([L1]);           // force:true primes a fresh entry
    const d = dbManager.getDB();
    d.prepare(`INSERT INTO tracks (filepath, library_id, title) VALUES ('t-late.mp3', ?, 'Late')`).run(L1);

    const cached = coverageLib.getEnrichmentCoverage([L1]);
    assert.equal(cached.totals.tracks, first.totals.tracks,
      'within the TTL the memo answers, not the DB');

    const fresh = coverageLib.getEnrichmentCoverage([L1], { force: true });
    assert.equal(fresh.totals.tracks, first.totals.tracks + 1,
      'force must re-read the DB');
  });
});
