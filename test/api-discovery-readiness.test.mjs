/**
 * `GET /api/` — features.discoveryReady.
 *
 * The public API-discovery endpoint reports whether a sonic-similarity query
 * would find anything RIGHT NOW. That is a different question from the ping's
 * `discovery` flag, which only says the feature is switched on: a server can
 * have discovery enabled with an unfinished scan, and that combination is what
 * makes clients look broken. Auto DJ sends similarTo/minSimilarity, every pick
 * 400s on the empty pool, and the queue silently stops advancing.
 *
 * These cover the readiness predicate itself (sim.hasEmbeddings), which is
 * what the endpoint returns. Three properties matter:
 *
 *   1. Off in config  → false without touching the database at all. The check
 *      must short-circuit, because /api/ is unauthenticated.
 *   2. On, no rows    → false. This is the case the field exists for.
 *   3. On, rows for a DIFFERENT model → false. A vector in another model's
 *      space cannot answer a query in this one, so "has rows" is not the same
 *      as "ready".
 *
 * It must also never throw: a capability probe that can 500 would take out the
 * endpoint that reports it.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as config from '../src/state/config.js';
import * as discoveryDb from '../src/db/discovery-db.js';
import * as sim from '../src/db/discovery-similarity.js';

const MODEL = 'test-model-1';
let tmpDir;
let cfgPath;

function setScanOptions({ collect, model = MODEL }) {
  config.program.scanOptions = {
    ...(config.program.scanOptions || {}),
    collectDiscoveryData: collect,
    discoveryModel: model,
  };
}

describe('GET /api/ -> features.discoveryReady', () => {
  before(async () => {
    // Real config.setup(), like mdns.test.mjs: program is undefined until it
    // runs, and the readiness check reads straight off it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-discovery-ready-'));
    cfgPath = path.join(tmpDir, 'config.json');
    await fsp.writeFile(cfgPath, JSON.stringify({
      port: 3000,
      storage: { dbDirectory: tmpDir },
    }));
    await config.setup(cfgPath);
    config.program.storage = { ...(config.program.storage || {}), dbDirectory: tmpDir };
  });

  after(async () => {
    try { discoveryDb.closeDiscoveryDb(); } catch { /* not open — nothing to close */ }
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('collectDiscoveryData off -> false, and no DB is opened', () => {
    setScanOptions({ collect: false });
    try { discoveryDb.closeDiscoveryDb(); } catch { /* not open — nothing to close */ }
    assert.equal(sim.hasEmbeddings(), false);
    // The short-circuit is the point: an unauthenticated caller must not be
    // able to make this endpoint open (or create) a database.
    assert.equal(discoveryDb.isDiscoveryDbOpen(), false);
  });

  test('enabled but nothing embedded -> false', () => {
    setScanOptions({ collect: true });
    discoveryDb.initDiscoveryDb(path.join(tmpDir, 'discovery.db'));
    assert.equal(sim.hasEmbeddings(), false, 'an empty table is not readiness');
  });

  test('a row with a NULL embedding is still not ready', () => {
    setScanOptions({ collect: true });
    const ddb = discoveryDb.getDiscoveryDb();
    ddb.prepare(
      `INSERT INTO discovery_tracks
         (audio_hash, updated_at, export_id, model_id, embedding)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('hash-pending', 1, 'anon:pending', MODEL);
    assert.equal(sim.hasEmbeddings(), false,
      'analysis queued is not analysis done');
  });

  test('an embedding for a DIFFERENT model is not ready either', () => {
    setScanOptions({ collect: true });
    const ddb = discoveryDb.getDiscoveryDb();
    ddb.prepare(
      `INSERT INTO discovery_tracks
         (audio_hash, updated_at, export_id, model_id, embedding)
       VALUES (?, ?, ?, ?, ?)`
    ).run('hash-other-model', 2, 'anon:other', 'some-other-model',
          Buffer.from([1, 2, 3, 4]));
    assert.equal(sim.hasEmbeddings(), false,
      "vectors in another model space cannot answer this model's queries");
  });

  test('one embedding for the configured model -> ready', () => {
    setScanOptions({ collect: true });
    const ddb = discoveryDb.getDiscoveryDb();
    ddb.prepare(
      `INSERT INTO discovery_tracks
         (audio_hash, updated_at, export_id, model_id, embedding)
       VALUES (?, ?, ?, ?, ?)`
    ).run('hash-ready', 3, 'anon:ready', MODEL, Buffer.from([1, 2, 3, 4]));
    assert.equal(sim.hasEmbeddings(), true);
  });

  test('never throws when the store is unusable', () => {
    setScanOptions({ collect: true });
    try { discoveryDb.closeDiscoveryDb(); } catch { /* not open — nothing to close */ }
    const good = config.program.storage.dbDirectory;
    config.program.storage = {
      ...config.program.storage,
      dbDirectory: path.join(tmpDir, 'does', 'not', 'exist'),
    };
    assert.doesNotThrow(() => sim.hasEmbeddings());
    assert.equal(sim.hasEmbeddings(), false);
    config.program.storage = { ...config.program.storage, dbDirectory: good };
  });
});
