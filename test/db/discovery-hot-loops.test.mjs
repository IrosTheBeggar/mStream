/**
 * Tests for the discovery JS hot-loop rework (audit PR-B: M9, C3-JS-half,
 * H8, M5):
 *
 *   - rankTracks topK must return exactly the head of the full ranking
 *     (the bounded heap is an optimization, never a semantic change);
 *   - pathBetween's batched selection + escalation must produce the same
 *     paths as the old full-sort walk, including when the visibility
 *     filter rejects more than a whole batch;
 *   - buildTierOrderExpr (the SQL twin of classifyRow) must order rows
 *     exactly as the JS classifier tiers them — placeholder/bind lockstep
 *     included;
 *   - runRandomSongs with BPM constraints must keep the tier-0 guarantee
 *     even when scope is far larger than the bounded pool (the M5 fix's
 *     core invariant), and sonic mode must keep the pool promise with the
 *     intersection pushed into SQL.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let testRoot;
let config, manager, ddb, sim, random;

const DIM = 16;
const vec = (...xs) => {
  const v = new Float32Array(DIM);
  xs.forEach((x, i) => { v[i] = x; });
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) { v[i] /= n; }
  return v;
};

// A deterministic hand-built index the pure-function tests share.
function buildFakeIndex(n) {
  const entries = [];
  const byHash = new Map();
  for (let i = 0; i < n; i++) {
    const e = {
      hash: `h${i}`,
      artist: `Artist ${i % 40}`,
      title: `Title ${i}`,
      vec: vec(Math.cos(i * 0.37), Math.sin(i * 0.37), (i % 7) / 7),
      genreTags: null,
    };
    entries.push(e);
    byHash.set(e.hash, e);
  }
  return { entries, byHash, dim: DIM };
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-hotloops-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.mkdirSync(path.join(testRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    folders: { rig: { root: path.join(testRoot, 'lib') } },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  config.program.scanOptions.collectDiscoveryData = true;
  config.program.scanOptions.discoveryModel = 'test-fake';

  manager = await import('../../src/db/manager.js');
  manager.initDB();
  ddb = await import('../../src/db/discovery-db.js');
  ddb.initDiscoveryDb(path.join(testRoot, 'db', 'discovery.db'));
  sim = await import('../../src/db/discovery-similarity.js');
  random = await import('../../src/api/random.js');
});

after(() => {
  try { manager.close(); } catch (_e) { /* closed */ }
  try { ddb.closeDiscoveryDb(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── rankTracks topK ─────────────────────────────────────────────────────────

describe('rankTracks topK', () => {
  test('topK returns exactly the head of the full ranking, same order', () => {
    const index = buildFakeIndex(500);
    const seed = vec(1, 0.2, 0.1);
    const full = sim.rankTracks(index, seed, 'h3');
    for (const k of [1, 7, 50, 499, 500, 5000]) {
      const bounded = sim.rankTracks(index, seed, 'h3', k);
      assert.equal(bounded.length, Math.min(k, full.length), `k=${k} length`);
      for (let i = 0; i < bounded.length; i++) {
        assert.equal(bounded[i].entry.hash, full[i].entry.hash, `k=${k} rank ${i}`);
        assert.equal(bounded[i].similarity, full[i].similarity, `k=${k} score ${i}`);
      }
    }
  });

  test('excludeHash never appears at any k', () => {
    const index = buildFakeIndex(100);
    const seed = index.byHash.get('h10').vec;
    for (const k of [5, 100]) {
      assert.ok(sim.rankTracks(index, seed, 'h10', k).every((r) => r.entry.hash !== 'h10'));
    }
  });
});

// ── pathBetween equivalence ─────────────────────────────────────────────────

// The pre-rework algorithm, kept verbatim as the oracle.
function oldPathBetween(index, hashA, hashB, waypoints, visible) {
  const a = index.byHash.get(hashA);
  const b = index.byHash.get(hashB);
  if (!a || !b || waypoints <= 0) { return []; }
  const dot = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) { s += x[i] * y[i]; } return s; };
  const nameKey = (e) => {
    if (!e || !e.title) { return null; }
    return `${(e.artist || '').trim().toLowerCase()}|${e.title.trim().toLowerCase()}`;
  };
  const used = new Set([hashA, hashB]);
  const usedNames = new Set([nameKey(a), nameKey(b)].filter(Boolean));
  const out = [];
  for (let k = 1; k <= waypoints; k++) {
    const t = k / (waypoints + 1);
    const w = sim.slerp(a.vec, b.vec, t);
    const ranked = [];
    for (const e of index.entries) {
      if (used.has(e.hash)) { continue; }
      const key = nameKey(e);
      if (key && usedNames.has(key)) { continue; }
      ranked.push({ hash: e.hash, key, similarity: dot(w, e.vec) });
    }
    ranked.sort((x, y) => y.similarity - x.similarity);
    let pick = null;
    for (const cand of ranked) {
      if (visible(cand.hash)) { pick = cand; break; }
      used.add(cand.hash);
    }
    if (!pick) { break; }
    used.add(pick.hash);
    if (pick.key) { usedNames.add(pick.key); }
    out.push({ hash: pick.hash, similarity: pick.similarity, t });
  }
  return out;
}

describe('pathBetween equivalence with the old full-sort walk', () => {
  test('everything visible: identical paths', () => {
    const index = buildFakeIndex(700);   // > one 256 batch
    const got = sim.pathBetween(index, 'h0', 'h699', 8, () => true);
    const want = oldPathBetween(buildFakeIndex(700), 'h0', 'h699', 8, () => true);
    assert.ok(got.length > 0, 'path produced');
    assert.deepEqual(got.map((p) => p.hash), want.map((p) => p.hash));
  });

  test('hostile visibility (rejects past a whole batch): escalation matches', () => {
    // Reject everything except a handful of high-index entries — the top
    // 256 candidates of early waypoints are all invisible, forcing the
    // full-ordering escalation.
    const allow = new Set(['h650', 'h651', 'h652', 'h653', 'h654', 'h655']);
    const visible = (h) => allow.has(h);
    const got = sim.pathBetween(buildFakeIndex(700), 'h0', 'h699', 4, visible);
    const want = oldPathBetween(buildFakeIndex(700), 'h0', 'h699', 4, visible);
    assert.ok(want.length > 0, 'oracle found picks');
    assert.deepEqual(got.map((p) => p.hash), want.map((p) => p.hash));
  });

  test('same-name dedupe still applies (memoized nameKey on hand-built entries)', () => {
    const index = buildFakeIndex(300);
    // Give three distinct hashes the same artist+title as the likely first
    // pick's — only one of the name-group may ever appear.
    const first = sim.pathBetween(buildFakeIndex(300), 'h0', 'h299', 6, () => true)[0];
    const twin = index.entries.find((e) => e.hash === first.hash);
    for (const h of ['h100', 'h200']) {
      const e = index.byHash.get(h);
      e.artist = twin.artist; e.title = twin.title;
      delete e.nameKey;   // hand-built indexes have no precomputed key
    }
    const got = sim.pathBetween(index, 'h0', 'h299', 6, () => true);
    const names = got.map((p) => {
      const e = index.byHash.get(p.hash);
      return `${e.artist}|${e.title}`.toLowerCase();
    });
    assert.equal(new Set(names).size, names.length, 'no artist+title repeats on the path');
  });
});

// ── buildTierOrderExpr ⇄ classifyRow lockstep ──────────────────────────────

describe('buildTierOrderExpr mirrors the JS tier classifier', () => {
  test('SQL tier ordering matches applyTierFilter tiers for every row shape', () => {
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, bpm REAL, musical_key TEXT)');
    const ins = mem.prepare('INSERT INTO t (bpm, musical_key) VALUES (?, ?)');
    const rows = [
      [120, 'C major'],   // good bpm, good key      → tier 0
      [120, null],        // good bpm, unknown key   → tier 0
      [120, 'F minor'],   // good bpm, WRONG key     → tier 2
      [null, 'C major'],  // unknown bpm, good key   → tier 0
      [null, null],       // unknown both            → tier 1
      [null, 'F minor'],  // unknown bpm, wrong key  → tier 2
      [80, 'C major'],    // WRONG bpm, good key     → tier 2
      [80, null],         // wrong bpm, unknown key  → tier 2
      [80, 'F minor'],    // wrong both              → tier 2
    ];
    for (const [bpm, key] of rows) { ins.run(bpm, key); }

    const body = { bpmRanges: [{ min: 110, max: 130 }], musicalKeys: ['8B'] };  // 8B = C major
    const tier = random.buildTierOrderExpr(body);
    assert.ok(tier, 'constraints present → expression built');

    const sqlTiers = mem.prepare(
      `SELECT id, ${tier.expr} AS tier FROM t ORDER BY id`
    ).all(...tier.params).map((r) => r.tier);

    // The JS authority, tier by tier.
    const all = mem.prepare('SELECT id, bpm, musical_key FROM t ORDER BY id').all();
    const t0 = new Set(random.applyTierFilter(all, body).map((r) => r.id));
    const rest = all.filter((r) => !t0.has(r.id));
    const t1 = new Set(random.applyTierFilter(rest, body).map((r) => r.id));
    const jsTiers = all.map((r) => (t0.has(r.id) ? 0 : t1.has(r.id) ? 1 : 2));

    assert.deepEqual(sqlTiers, jsTiers, 'SQL CASE and classifyRow must agree row-for-row');
    mem.close();
  });

  test('no constraints → null (no ORDER BY term)', () => {
    assert.equal(random.buildTierOrderExpr({}), null);
    assert.equal(random.buildTierOrderExpr({ bpmRanges: [], musicalKeys: [] }), null);
  });
});

// ── runRandomSongs invariants at scale (> the bounded pool) ────────────────

describe('runRandomSongs bounded pools keep their guarantees', () => {
  const IN_RANGE = 12;      // tier-0 rows, deliberately rarer than the pool
  const SONIC_OK = 15;      // hashes inside the similarity range
  let inRangeIds;
  let sonicHashes;

  before(() => {
    const m = manager.getDB();
    m.exec('BEGIN');
    // initDB seeds the libraries table from config.folders — the 'rig'
    // library already exists; just resolve its id.
    const libId = m.prepare("SELECT id FROM libraries WHERE name='rig'").get().id;
    const ins = m.prepare(`INSERT INTO tracks (filepath, library_id, title, bpm, musical_key, audio_hash, format)
                           VALUES (?, ?, ?, ?, ?, ?, 'mp3')`);
    inRangeIds = new Set();
    // 400 rows: 12 in-range BPM (tier 0), the rest split unknown/wrong.
    for (let i = 0; i < 400; i++) {
      const bpm = i < IN_RANGE ? 120 : (i % 2 === 0 ? null : 80);
      const r = ins.run(`f${i}.mp3`, libId, `T${i}`, bpm, null, `rh-${i}`);
      if (i < IN_RANGE) { inRangeIds.add(Number(r.lastInsertRowid)); }
    }
    m.exec('COMMIT');

    // Discovery rows: the seed + SONIC_OK near vectors + far ballast.
    const d = ddb.getDiscoveryDb();
    d.exec('BEGIN');
    sonicHashes = new Set();
    for (let i = 0; i < 400; i++) {
      const near = i > 0 && i <= SONIC_OK;
      const v = i === 0 ? vec(1, 0) : near ? vec(0.95, 0.31) : vec(0, 1);
      ddb.upsertDiscoveryTrack({
        audioHash: `rh-${i}`, artist: `A${i % 40}`, title: `T${i}`, duration: 100,
        modelId: 'test-fake', modelVersion: '1',
        embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
      });
      if (near) { sonicHashes.add(`rh-${i}`); }
    }
    d.exec('COMMIT');
    ddb.publishIndexEpoch();
    sim.invalidate();
  });

  test('tier-0 rows always win although 97% of scope is tier-1/2 (M5 invariant)', () => {
    const req = { user: undefined };
    for (let i = 0; i < 25; i++) {
      const out = random.runRandomSongs(req, { bpmRanges: [{ min: 110, max: 130 }] });
      // resolve the picked id back through the ignoreList round-trip shape
      const pickedId = out.ignoreList[out.ignoreList.length - 1];
      assert.ok(inRangeIds.has(pickedId),
        `pick ${i} must be tier-0 (got track id ${pickedId})`);
    }
  });

  test('sonic pool promise holds with the intersection in SQL (H8 shape)', () => {
    const req = { user: undefined };
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const out = random.runRandomSongs(req, {
        similarTo: ['rig/f0.mp3'], minSimilarity: 0.9, ignoreList: [],
      });
      assert.equal(out.sonic.poolSize, SONIC_OK, 'poolSize reflects the allowed set');
      const picked = out.songs[0];
      seen.add(picked.metadata.title);
      assert.ok(out.sonic.similarity >= 0.9, `pick similarity ${out.sonic.similarity}`);
    }
    assert.ok(seen.size > 3, `picks vary across the pool (saw ${seen.size} distinct)`);
  });

  test('sonic + impossible threshold → clean 400, nothing materialised', () => {
    const req = { user: undefined };
    assert.throws(
      () => random.runRandomSongs(req, { similarTo: ['rig/f0.mp3'], minSimilarity: 0.9999 }),
      /similarity range/);
  });
});
