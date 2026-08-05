/**
 * Tests for the status/admin heavy-hitter fixes (audit PR-E: H6, H2, M1,
 * M3):
 *
 *   - V63 puts library_id indexes on cue_points + play_events, and the
 *     discovery V2 partial index backs the coverage counts;
 *   - getEnrichmentCoverage serves STALE data on TTL expiry and refreshes
 *     off-request (stale-while-revalidate), memoises the globally-scoped
 *     passes across library signatures, and force:true still recomputes
 *     synchronously;
 *   - deleteLibraryRows removes >chunk-size libraries fully (tracks,
 *     cascades, play_events SET NULL) without a single monolithic DELETE;
 *   - POST /api/v1/share caps the playlist at the producer, and
 *     GET /api/v1/admin/db/shared returns counts, never blobs (live
 *     server).
 *
 * The M1 drain (chunked + async hash-transition apply) keeps its coverage
 * in test/integration/hash-transition-applier.test.mjs, which runs the
 * real drain hook end-to-end.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../helpers/server.mjs';

// Captured at import by enrichment-status-lib.js — set before the dynamic
// imports below. Long enough that back-to-back calls in one test stay
// inside the window, short enough that "aging out" is a quick sleep.
process.env.MSTREAM_TEST_COVERAGE_TTL_MS = '150';

let testRoot;
let config, manager, ddb, coverage, adminUtil;
let L1, L2, L3;

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-pre-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
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
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  ddb = await import('../../src/db/discovery-db.js');
  ddb.initDiscoveryDb(path.join(testRoot, 'db', 'discovery.db'));
  coverage = await import('../../src/db/enrichment-status-lib.js');
  adminUtil = await import('../../src/util/admin.js');

  const d = manager.getDB();
  d.exec('BEGIN');
  for (const name of ['lib1', 'lib2', 'lib3']) {
    d.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks)
               VALUES (?, ?, 'music', 0)`).run(name, path.join(testRoot, name));
  }
  manager.invalidateCache();
  L1 = d.prepare("SELECT id FROM libraries WHERE name='lib1'").get().id;
  L2 = d.prepare("SELECT id FROM libraries WHERE name='lib2'").get().id;
  L3 = d.prepare("SELECT id FROM libraries WHERE name='lib3'").get().id;
  const ins = d.prepare('INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)');
  for (let i = 0; i < 5; i++) { ins.run(`a${i}.mp3`, L1, `A${i}`); }
  for (let i = 0; i < 3; i++) { ins.run(`b${i}.mp3`, L2, `B${i}`); }
  d.exec('COMMIT');
});

after(() => {
  try { manager.close(); } catch (_e) { /* closed */ }
  try { ddb.closeDiscoveryDb(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── migrations ──────────────────────────────────────────────────────────────

describe('V63 + discovery V2 indexes', () => {
  test('library_id indexes exist on cue_points and play_events', () => {
    const names = manager.getDB().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN "
      + "('idx_cue_points_library','idx_play_events_library')"
    ).all().map((r) => r.name).sort();
    assert.deepEqual(names, ['idx_cue_points_library', 'idx_play_events_library']);
  });

  test('discovery.db lands at V2 with the embedded-model partial index', () => {
    const d2 = ddb.getDiscoveryDb();
    assert.equal(d2.prepare('PRAGMA user_version').get().user_version, 2);
    const idx = d2.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_discovery_tracks_embedded_model'"
    ).get();
    assert.ok(idx, 'partial index present');
    assert.match(idx.sql, /WHERE embedding IS NOT NULL/);
  });
});

// ── H6: stale-while-revalidate coverage ─────────────────────────────────────

describe('getEnrichmentCoverage caching', () => {
  test('fresh window serves the memo; expiry serves STALE and refreshes off-request', async () => {
    coverage.invalidateCoverageCache();
    const c1 = coverage.getEnrichmentCoverage([L1]);
    assert.equal(c1.totals.tracks, 5);
    assert.equal(coverage.getEnrichmentCoverage([L1]), c1, 'inside the TTL: same object');

    // Change the world, age the memo out.
    manager.getDB().prepare("INSERT INTO tracks (filepath, library_id, title) VALUES ('a5.mp3', ?, 'A5')")
      .run(L1);
    await sleep(200);   // > MSTREAM_TEST_COVERAGE_TTL_MS

    const stale = coverage.getEnrichmentCoverage([L1]);
    assert.equal(stale, c1, 'expired memo is served AS-IS — the poll never blocks on a recompute');
    assert.equal(stale.totals.tracks, 5, 'still the old count');

    // The chunked background refresh lands within a few ticks.
    let fresh;
    for (let i = 0; i < 50; i++) {
      await sleep(20);
      fresh = coverage.getEnrichmentCoverage([L1]);
      if (fresh !== c1) { break; }
    }
    assert.notEqual(fresh, c1, 'background refresh replaced the memo');
    assert.equal(fresh.totals.tracks, 6, 'and it sees the new track');
  });

  test('globally-scoped passes are shared across library signatures', () => {
    coverage.invalidateCoverageCache();
    const a = coverage.getEnrichmentCoverage([L1]);
    const b = coverage.getEnrichmentCoverage([L2]);
    assert.notEqual(a, b, 'different signatures, different snapshots');
    assert.equal(a.passes.waveform, b.passes.waveform,
      'waveform counts computed once for both signatures');
    assert.equal(a.passes.discovery, b.passes.discovery,
      'discovery counts computed once for both signatures');
    assert.equal(a.totals.tracks, 6);
    assert.equal(b.totals.tracks, 3, 'library-scoped counts still differ');
  });

  test('force recomputes synchronously', () => {
    const before_ = coverage.getEnrichmentCoverage([L1]);
    manager.getDB().prepare("INSERT INTO tracks (filepath, library_id, title) VALUES ('a6.mp3', ?, 'A6')")
      .run(L1);
    const forced = coverage.getEnrichmentCoverage([L1], { force: true });
    assert.notEqual(forced, before_);
    assert.equal(forced.totals.tracks, 7, 'force sees the write immediately');
  });
});

// ── H2: chunked library delete ──────────────────────────────────────────────

describe('deleteLibraryRows', () => {
  test('removes a >chunk-size library fully, cascades intact', async () => {
    const d = manager.getDB();
    d.exec('BEGIN');
    const insT = d.prepare('INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)');
    for (let i = 0; i < 1200; i++) { insT.run(`c${i}.mp3`, L3, `C${i}`); }
    d.prepare(`INSERT INTO users (username, password, salt) VALUES ('pe-user', 'x', 'y')`).run();
    const uid = d.prepare("SELECT id FROM users WHERE username='pe-user'").get().id;
    d.prepare(`INSERT INTO cue_points (filepath, library_id, position) VALUES ('c0.mp3', ?, 1.5)`).run(L3);
    d.prepare(`INSERT INTO play_events (event_id, user_id, filepath, library_id)
               VALUES ('pe-evt-1', ?, 'c0.mp3', ?)`).run(uid, L3);
    d.exec('COMMIT');

    await adminUtil.deleteLibraryRows(d, L3);

    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?').get(L3).n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM libraries WHERE id = ?').get(L3).n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM cue_points WHERE library_id = ?').get(L3).n, 0,
      'cue_points cascade');
    const pe = d.prepare("SELECT library_id FROM play_events WHERE event_id = 'pe-evt-1'").get();
    assert.ok(pe, 'play event survives the library');
    assert.equal(pe.library_id, null, 'library_id nulled by the cascade');
    // Other libraries untouched.
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?').get(L1).n, 7);
  });
});

// ── M3: share producer cap + admin listing shape (live server) ──────────────

describe('shared playlists: producer cap + admin listing', () => {
  let server;
  let token;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: true,
      users: [{ username: 'admin', password: 'pw', admin: true }],
    });
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw' }),
    });
    token = (await r.json()).token;
  });
  after(async () => { if (server) { await server.stop(); } });

  const post = (route, body) => fetch(`${server.baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body),
  });

  test('a normal share is accepted; the admin list carries counts, never blobs', async () => {
    const r = await post('/api/v1/share', { playlist: ['testlib/a.mp3', 'testlib/b.mp3'] });
    assert.equal(r.status, 200);
    const { playlistId } = await r.json();
    assert.ok(playlistId);

    const list = await fetch(`${server.baseUrl}/api/v1/admin/db/shared`, {
      headers: { 'x-access-token': token } });
    assert.equal(list.status, 200);
    const rows = await list.json();
    const mine = rows.find((x) => x.playlistId === playlistId);
    assert.ok(mine, 'share listed');
    assert.equal(mine.trackCount, 2, 'count travels');
    assert.equal(mine.user, 'admin');
    assert.ok(!('playlist' in mine), 'the blob itself never leaves the DB');
  });

  test('an oversized share is rejected at the producer', async () => {
    const r = await post('/api/v1/share', {
      playlist: Array.from({ length: 5001 }, (_, i) => `testlib/x${i}.mp3`),
    });
    assert.equal(r.status, 400);
  });
});
