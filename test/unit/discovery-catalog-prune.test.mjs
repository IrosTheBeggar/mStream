/**
 * Catalog retention pruning (discovery-catalog.pruneStalePeers) — the
 * "forget offline servers" rules, no sidecar or server needed:
 *
 *  - entries not heard from in discoveryP2p.peerRetentionDays are dropped;
 *  - the keep-set (peers whose snapshot is on the local shelf) always wins —
 *    over staleness AND over the blocklist;
 *  - blocked peers are dropped regardless of age (record() refuses their
 *    announcements, so a leftover entry could never refresh itself);
 *  - peerRetentionDays = 0 disables age-based pruning but not blocked-drop;
 *  - an unparseable updatedAt counts as stale, not immortal;
 *  - a pruned peer re-enters the catalog on its next announcement.
 *
 * The catalog file is crafted on disk BEFORE the module's lazy first load so
 * entry ages are controlled without reaching into module state. The hourly
 * timer + neighbor gate (startPruning/prunePass) need a live sidecar and are
 * exercised by the integration suite's stack lifecycle.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as config from '../../src/state/config.js';
import * as catalog from '../../src/state/discovery-catalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Distinct 64-hex endpoint ids, à la real iroh endpoint ids.
const id = (seed) => seed.repeat(64).slice(0, 64);
const FRESH = id('a');
const STALE = id('b');
const HELD = id('c');
const BLOCKED = id('d');
const BAD_DATE = id('e');

function entry(from, updatedAt, seq = 1) {
  return {
    from,
    payload: { snapshotSeq: seq, hash: `hash-${from.slice(0, 4)}`, name: from.slice(0, 4), rowCount: 10, modelId: 'test-model' },
    firstSeenAt: new Date(NOW - 200 * DAY_MS).toISOString(),
    updatedAt,
  };
}

let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-catalog-prune-'));
  await config.setup(path.join(tmpDir, 'config.json'));
  config.program.storage.dbDirectory = tmpDir;
  // Written before the module's first ensureLoaded so ages are ours to pick.
  const dir = path.join(tmpDir, 'discovery-p2p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify([
    entry(FRESH, new Date(NOW).toISOString()),
    entry(STALE, new Date(NOW - 100 * DAY_MS).toISOString()),
    entry(HELD, new Date(NOW - 100 * DAY_MS).toISOString()),
    entry(BLOCKED, new Date(NOW).toISOString()),
    entry(BAD_DATE, 'not-a-timestamp'),
  ]));
});

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

describe('discovery-catalog retention pruning', () => {
  test('loads the crafted catalog', () => {
    assert.equal(catalog.size(), 5);
  });

  test('drops stale + blocked + unparseable; keeps fresh and shelf-pinned', () => {
    config.program.discoveryP2p.peerRetentionDays = 30;
    config.program.discoveryP2p.blockedPeers = [BLOCKED];
    const dropped = catalog.pruneStalePeers({ keep: new Set([HELD]), now: NOW });
    assert.deepEqual(dropped.sort(), [STALE, BLOCKED, BAD_DATE].sort());
    assert.deepEqual(catalog.list().map((e) => e.from).sort(), [FRESH, HELD].sort());
  });

  test('nothing to drop → returns empty, catalog untouched', () => {
    const dropped = catalog.pruneStalePeers({ keep: new Set([HELD]), now: NOW });
    assert.deepEqual(dropped, []);
    assert.equal(catalog.size(), 2);
  });

  test('retention 0 keeps silent peers forever (but still drops blocked)', () => {
    config.program.discoveryP2p.peerRetentionDays = 0;
    config.program.discoveryP2p.blockedPeers = [FRESH];
    // A century of silence: age-pruning is off, so only the blocked id goes.
    const dropped = catalog.pruneStalePeers({ now: NOW + 36500 * DAY_MS });
    assert.deepEqual(dropped, [FRESH]);
    assert.deepEqual(catalog.list().map((e) => e.from), [HELD]);
  });

  test('keep-set shields a blocked peer too', () => {
    config.program.discoveryP2p.blockedPeers = [HELD];
    assert.deepEqual(catalog.pruneStalePeers({ keep: new Set([HELD]), now: NOW }), []);
    assert.equal(catalog.size(), 1);
    config.program.discoveryP2p.blockedPeers = [];
  });

  test('a pruned peer re-enters the catalog on its next announcement', () => {
    config.program.discoveryP2p.peerRetentionDays = 30;
    // Everything left (HELD, silent 100 days) goes once its pin is gone…
    assert.deepEqual(catalog.pruneStalePeers({ now: NOW }), [HELD]);
    assert.equal(catalog.size(), 0);
    // …and one announcement brings it straight back.
    assert.equal(catalog.record(HELD, { snapshotSeq: 2, hash: 'h2', name: 'back', rowCount: 5, modelId: 'test-model' }), true);
    assert.equal(catalog.size(), 1);
    assert.equal(catalog.get(HELD).payload.snapshotSeq, 2);
  });
});

describe('discovery-catalog manual forget', () => {
  test('forget drops a known peer, reports an unknown one, and record() undoes it', () => {
    assert.equal(catalog.forget(HELD), true);
    assert.equal(catalog.size(), 0);
    assert.equal(catalog.forget(HELD), false, 'already forgotten');
    // Forgetting is never permanent: the next announcement re-creates it.
    assert.equal(catalog.record(HELD, { snapshotSeq: 3, hash: 'h3', name: 'back-again', rowCount: 5, modelId: 'test-model' }), true);
    assert.equal(catalog.get(HELD).payload.snapshotSeq, 3);
  });
});
