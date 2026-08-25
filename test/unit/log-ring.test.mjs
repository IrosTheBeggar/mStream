/**
 * The dual log-ring in src/logger.js: one main ring behind the admin
 * live-log viewer, one fixed-size discovery/p2p ring behind the Discovery
 * panel's Activity feed. The p2p ring exists so a chatty scan can never
 * wash mesh events out of the feed — these tests pin that isolation, the
 * prefix filter, and the independent seq-cursor contracts.
 *
 * Importing src/logger.js configures the global winston instance (console +
 * ring transports), so logging here prints a few lines to the test output —
 * harmless, and exactly the production write path we want under test.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import winston from 'winston';
import * as logger from '../../src/logger.js';

// The ring transport pushes entries inside the transport's log() call, which
// winston invokes synchronously on winston.info(); the setImmediate inside is
// only the 'logged' event. One microtask hop keeps us honest anyway.
const settle = () => new Promise((r) => setImmediate(r));

describe('log rings: main + dedicated discovery/p2p', () => {
  test('a p2p-prefixed line lands in both rings; a plain line only in main', async () => {
    const mainBefore = logger.getRecentLogs(0).lastSeq;
    const p2pBefore = logger.getP2pActivity(0).lastSeq;

    winston.info('[discovery-p2p] mesh neighbor up: abcdef123456…');
    winston.info('scan finished: 1234 files in 5s'); // the wash-out threat
    winston.warn('[p2p-sidecar] exited (code=1 signal=null)');
    await settle();

    const main = logger.getRecentLogs(mainBefore);
    const p2p = logger.getP2pActivity(p2pBefore);

    assert.equal(main.entries.length, 3, 'main ring sees every line');
    assert.equal(p2p.entries.length, 2, 'p2p ring sees only the prefixed lines');
    assert.ok(p2p.entries[0].message.startsWith('[discovery-p2p] mesh neighbor up'));
    assert.equal(p2p.entries[1].level, 'warn', 'level survives into the ring');
    assert.ok(p2p.entries.every((e) => /^\[(discovery-|p2p-sidecar)/.test(e.message)),
      'nothing un-prefixed leaks into the feed');
  });

  test('seq cursors are independent and delta polls return only news', async () => {
    winston.info('plain line — main ring only');
    await settle();
    const p2pCursor = logger.getP2pActivity(0).lastSeq;

    winston.info('another plain line');
    await settle();
    assert.equal(logger.getP2pActivity(p2pCursor).entries.length, 0,
      'plain lines never advance the p2p ring');

    winston.info('[discovery-seeds] mesh-health watch: all quiet');
    await settle();
    const delta = logger.getP2pActivity(p2pCursor);
    assert.equal(delta.entries.length, 1, 'exactly the one new p2p line');
    assert.equal(delta.lastSeq, p2pCursor + 1);

    // The stale-cursor recovery contract: an impossible cursor (from before
    // a restart) falls back to the full buffer instead of returning nothing.
    const recovered = logger.getP2pActivity(delta.lastSeq + 1000);
    assert.ok(recovered.entries.length > 0, 'stale cursor recovers the buffer');
  });

  test('an oversized p2p line is truncated, not dropped', async () => {
    const cursor = logger.getP2pActivity(0).lastSeq;
    winston.info(`[discovery-catalog] ${'x'.repeat(5000)}`);
    await settle();
    const { entries } = logger.getP2pActivity(cursor);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].message.endsWith('… [truncated]'));
    assert.ok(entries[0].message.length <= 4000 + '… [truncated]'.length);
  });

  test('resizing the main ring leaves the p2p ring untouched', async () => {
    const cursor = logger.getP2pActivity(0).lastSeq;
    winston.info('[discovery-peer-dbs] fetched snapshot from aaaa…');
    await settle();

    logger.setBufferCapacity(10);
    const p2p = logger.getP2pActivity(cursor);
    assert.equal(p2p.entries.length, 1, 'p2p ring survives a main-ring resize');
    assert.equal(p2p.capacity, 500, 'p2p capacity is fixed, not the configured one');
    assert.equal(logger.getRecentLogs(0).capacity, 10, 'main ring took the new capacity');

    logger.setBufferCapacity(500); // restore for any suite that runs after us
  });
});
