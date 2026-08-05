/**
 * Tests for the discovery-infrastructure churn fixes (audit PR-C):
 *
 *   H5  the similarity index invalidates on the batch-grained
 *       discovery_meta.index_epoch, not on per-row row_seq churn — with a
 *       row_seq fallback for pre-epoch DBs and a time-boxed safety net for
 *       writers that move rows without publishing;
 *   H3  exportDiscoverySnapshot builds in a forked child (proved here by
 *       exporting with the parent's discovery singleton CLOSED — the parent
 *       cannot build in that state, so success means the child did);
 *   H4  the peer matrix cache is LRU with a cap that tracks autoFetchCount —
 *       cyclic access over the whole peer set (the p2p similar route's
 *       access pattern) must hit, not thrash;
 *   M13 localIdentitySets is cached across requests, invalidated by lib
 *       data_version / discovery epoch movement / the TTL.
 *
 * Strategy: real modules against temp DBs, no server. config.setup runs
 * first because the similarity index and the peer registry read config at
 * call time; the env overrides are set before the dynamic imports because
 * both modules capture them at import.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

// Captured at import by discovery-similarity.js / discovery-peer-dbs.js —
// must be set before the dynamic imports below.
process.env.MSTREAM_TEST_SIM_STALE_REBUILD_MS = '80';

let testRoot;
let config, ddb, sim, manager, novelty, peerDbs, discoveryExport;
let MODEL;
let discoveryPath;

function blob(floats) {
  return Buffer.from(new Float32Array(floats).buffer);
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mstream-disc-churn-`));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  MODEL = config.program.scanOptions.discoveryModel;

  ddb = await import('../../src/db/discovery-db.js');
  sim = await import('../../src/db/discovery-similarity.js');
  manager = await import('../../src/db/manager.js');
  novelty = await import('../../src/db/discovery-novelty.js');
  peerDbs = await import('../../src/state/discovery-peer-dbs.js');
  discoveryExport = await import('../../src/db/discovery-export.js');

  discoveryPath = path.join(testRoot, 'db', 'discovery.db');
  ddb.initDiscoveryDb(discoveryPath);
  manager.initDB();
});

after(() => {
  try { manager.close(); } catch (_e) { /* already closed */ }
  try { ddb.closeDiscoveryDb(); } catch (_e) { /* already closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
  setImmediate(() => process.exit(0));
});

function upsert(hash, vec, extra = {}) {
  ddb.upsertDiscoveryTrack({
    audioHash: hash, artist: extra.artist ?? 'Art', title: extra.title ?? hash,
    duration: 120, modelId: MODEL, modelVersion: '1', embedding: blob(vec),
    ...extra,
  });
}

describe('H5: similarity index epoch invalidation', () => {
  test('without a published epoch, per-write invalidation still applies (fallback)', () => {
    upsert('h-a', [1, 0, 0, 0]);
    const i1 = sim.getIndex();
    assert.equal(i1.entries.length, 1);
    upsert('h-b', [0, 1, 0, 0]);
    const i2 = sim.getIndex();
    assert.notEqual(i2, i1, 'row_seq moved → rebuilt');
    assert.equal(i2.entries.length, 2);
  });

  test('with a published epoch, per-row writes stop rebuilding; a publish rebuilds', () => {
    ddb.publishIndexEpoch();
    const i1 = sim.getIndex();               // key switches to the epoch
    upsert('h-c', [0, 0, 1, 0]);             // row_seq moves, epoch does not
    const i2 = sim.getIndex();
    assert.equal(i2, i1, 'unpublished write must serve the cached index');
    assert.equal(i2.entries.length, 2, 'h-c not visible before a publish');

    ddb.publishIndexEpoch();
    const i3 = sim.getIndex();
    assert.notEqual(i3, i1, 'publish moves the key');
    assert.equal(i3.entries.length, 3, 'h-c visible after the publish');
  });

  test('safety net: unpublished drift rebuilds once the debounce window passes', async () => {
    sim.invalidate();
    const base = sim.getIndex();             // fresh build → builtAt = now
    upsert('h-d', [0, 0, 0, 1]);             // drift, no publish
    assert.equal(sim.getIndex(), base, 'inside the window: still cached');
    await sleep(120);                         // > MSTREAM_TEST_SIM_STALE_REBUILD_MS
    const i2 = sim.getIndex();
    assert.notEqual(i2, base, 'aged cache + drift → rebuilt despite the epoch');
    assert.equal(i2.entries.length, 4);
  });

  test('applyHashTransitionGroups publishes: re-keyed hashes reach the index', () => {
    const before_ = sim.getIndex();
    assert.ok(before_.byHash.has('h-a'));
    const out = ddb.applyHashTransitionGroups([{ target: 'h-a2', sources: ['h-a'] }]);
    assert.equal(out.moved, 1);
    const after_ = sim.getIndex();
    assert.notEqual(after_, before_, 'the drain is a batch owner — no manual publish needed');
    assert.ok(after_.byHash.has('h-a2'));
    assert.ok(!after_.byHash.has('h-a'));
  });

  test('bumpRowSeq moves the rowversion without writing a row', () => {
    const beforeSeq = Number(ddb.getMeta('row_seq'));
    ddb.bumpRowSeq();
    assert.equal(Number(ddb.getMeta('row_seq')), beforeSeq + 1);
  });
});

describe('M13: localIdentitySets cache', () => {
  before(() => {
    const m = manager.getDB();
    m.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks)
               VALUES ('churn-lib', ?, 'music', 0)`).run(testRoot);
    const artistId = m.prepare(`INSERT INTO artists (name) VALUES ('First Artist')`).run().lastInsertRowid;
    m.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id)
               VALUES ('a.mp3', (SELECT id FROM libraries WHERE name='churn-lib'), 'First Song', ?)`)
      .run(artistId);
    novelty.invalidateIdentityCache();
  });

  test('repeat calls serve the cached sets', () => {
    const s1 = novelty.localIdentitySets();
    assert.ok(s1.artists.has('firstartist'));
    const s2 = novelty.localIdentitySets();
    assert.equal(s2, s1, 'same object — no rebuild');
  });

  test('a commit from ANOTHER connection (scanner/worker shape) rebuilds', () => {
    const s1 = novelty.localIdentitySets();
    const other = new DatabaseSync(path.join(testRoot, 'db', 'mstream.db'));
    try {
      const aid = other.prepare(`INSERT INTO artists (name) VALUES ('Second Artist')`).run().lastInsertRowid;
      other.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id)
                     VALUES ('b.mp3', (SELECT id FROM libraries WHERE name='churn-lib'), 'Second Song', ?)`)
        .run(aid);
    } finally { other.close(); }
    const s2 = novelty.localIdentitySets();
    assert.notEqual(s2, s1, 'data_version moved → rebuilt');
    assert.ok(s2.artists.has('secondartist'));
  });

  test('discovery epoch movement rebuilds (fresh MBIDs become exclusions)', () => {
    const s1 = novelty.localIdentitySets();
    assert.ok(!s1.mbids.has('mbid-fresh'));
    upsert('h-mbid', [0.5, 0.5, 0.5, 0.5], { recordingMbid: 'mbid-fresh' });
    ddb.publishIndexEpoch();
    const s2 = novelty.localIdentitySets();
    assert.notEqual(s2, s1);
    assert.ok(s2.mbids.has('mbid-fresh'));
  });

  test('invalidateIdentityCache forces the next call to rebuild', () => {
    const s1 = novelty.localIdentitySets();
    novelty.invalidateIdentityCache();
    assert.notEqual(novelty.localIdentitySets(), s1);
  });
});

describe('H4: peer matrix cache', () => {
  const PEER_IDS = [];
  const peerModel = 'peer-model';

  before(() => {
    // Seven peers: one more than the default autoFetchCount of 6, so the
    // LRU test below has something to evict.
    const peersDir = path.join(testRoot, 'db', 'discovery-peers');
    fs.mkdirSync(peersDir, { recursive: true });
    const registry = [];
    for (let i = 0; i < 7; i++) {
      const endpointId = String(i).repeat(64);
      const hash = String(i).repeat(64);
      const p = path.join(peersDir, `${hash}.db`);
      const pdb = new DatabaseSync(p);
      pdb.exec(`CREATE TABLE tracks (export_id TEXT, recording_mbid TEXT, artist TEXT,
        title TEXT, duration REAL, model_id TEXT, model_version TEXT, embedding BLOB)`);
      const ins = pdb.prepare(`INSERT INTO tracks (export_id, artist, title, duration, model_id, embedding)
        VALUES (?, ?, ?, 100, ?, ?)`);
      for (let r = 0; r < 3; r++) {
        ins.run(`anon:p${i}r${r}`, `Peer${i}Artist`, `Song${r}`, peerModel, blob([i, r, 0, 1]));
      }
      pdb.close();
      PEER_IDS.push(endpointId);
      registry.push({
        endpointId, hash, path: p, snapshotSeq: 1, modelId: peerModel,
        rowCount: 3, sizeBytes: 4096, name: `Peer ${i}`, fetchedAt: new Date().toISOString(),
      });
    }
    const p2pDir = path.join(testRoot, 'db', 'discovery-p2p');
    fs.mkdirSync(p2pDir, { recursive: true });
    fs.writeFileSync(path.join(p2pDir, 'peer-dbs.json'), JSON.stringify(registry));
  });

  test('cyclic access over autoFetchCount peers is a 100% hit on round two', () => {
    assert.equal(config.program.discoveryP2p.autoFetchCount, 6, 'test assumes the config default');
    const six = PEER_IDS.slice(0, 6);
    const round1 = six.map((id) => peerDbs.readEmbeddings(id, peerModel));
    assert.ok(round1.every(Boolean), 'all six peers readable');
    const round2 = six.map((id) => peerDbs.readEmbeddings(id, peerModel));
    for (let i = 0; i < 6; i++) {
      assert.equal(round2[i], round1[i],
        `peer ${i}: round two must serve the cached matrix (old FIFO cap of 4 thrashed to 0% here)`);
    }
  });

  test('eviction is LRU: a touched entry survives, the least-recent goes', () => {
    const six = PEER_IDS.slice(0, 6);
    const first = peerDbs.readEmbeddings(six[0], peerModel);   // touch peer 0 → most recent
    const oldest = peerDbs.readEmbeddings(six[1], peerModel);  // then peer 1
    // Re-touch every OTHER peer so peer 1 is the least recently used…
    for (const id of [six[2], six[3], six[4], six[5], six[0]]) {
      peerDbs.readEmbeddings(id, peerModel);
    }
    // …then bring in peer 7, forcing one eviction past the cap of 6.
    assert.ok(peerDbs.readEmbeddings(PEER_IDS[6], peerModel));
    assert.equal(peerDbs.readEmbeddings(six[0], peerModel), first,
      'recently touched matrix survived the eviction');
    assert.notEqual(peerDbs.readEmbeddings(six[1], peerModel), oldest,
      'least-recently-used matrix was the one evicted');
  });
});

describe('H3: export runs in a forked child', () => {
  test('export succeeds with the parent singleton closed — only the child can have built it', async () => {
    const outDir = path.join(testRoot, 'export');
    ddb.closeDiscoveryDb();
    try {
      const manifest = await discoveryExport.exportDiscoverySnapshot({ dbPath: discoveryPath, outDir });
      assert.ok(manifest.rowCount >= 4, `expected the seeded rows, got ${manifest.rowCount}`);
      assert.ok(fs.existsSync(path.join(outDir, 'discovery-export.db')));
      const snap = new DatabaseSync(path.join(outDir, 'discovery-export.db'), { readOnly: true });
      try {
        assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, manifest.rowCount);
      } finally { snap.close(); }
    } finally {
      ddb.initDiscoveryDb(discoveryPath);
    }
  });

  test('concurrent same-target exports coalesce onto one build', async () => {
    const outDir = path.join(testRoot, 'export-coalesce');
    const [m1, m2] = await Promise.all([
      discoveryExport.exportDiscoverySnapshot({ dbPath: discoveryPath, outDir }),
      discoveryExport.exportDiscoverySnapshot({ dbPath: discoveryPath, outDir }),
    ]);
    assert.equal(m1.generatedAt, m2.generatedAt, 'both callers got the same build');
  });
});
