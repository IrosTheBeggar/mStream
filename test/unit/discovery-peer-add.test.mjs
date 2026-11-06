/**
 * The Add state machine (src/state/discovery-peer-add.js) and the test
 * switches it leans on in src/state/discovery-p2p.js.
 *
 *   - the route's pre-checks and status table (isBlocked before the
 *     catalog lookup), the stored outcomes and their lifetimes
 *   - two downloads at a time, a FIFO queue that reports adding, and the
 *     re-plan when a queued Add starts
 *   - fetch first: the plan's evictees are fetchPeer's `discount`; a no-room
 *     from the download re-plans
 *   - the wire codes, the clearing on any shelf change, reset() on a stop,
 *     the admin panel's synchronous fetch (track), the log lines
 *
 * Most of it drives createPeerAdder against fakes the test steers by hand:
 * a fetchPeer whose downloads settle only when told to, a planRoomFor that
 * answers whatever plan the test sets, a clock. One describe runs the
 * default instance against the real shelf (peer-dbs, the catalog, the fake
 * fetch under MSTREAM_TEST_P2P_FAKE_FETCH_DIR), with the download held open
 * through peer-dbs' setFetchForTests so it can be watched mid-flight. The
 * last describe pins the discovery-p2p.js switches themselves.
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';

// Captured by peer-dbs at import: a real statfs must never refuse a fetch.
process.env.MSTREAM_TEST_DISCOVERY_DISK_FLOOR_BYTES = '1';
// Belt and braces: nothing here may fetch a real sidecar.
process.env.MSTREAM_SIDECAR_BASE = 'http://127.0.0.1:9';

const MODEL = 'test-model';
const MINUTE = 60 * 1000;
const id = (ch) => ch.repeat(64);
const hashOf = (ch) => `f${ch.repeat(63)}`;
// src/logger.js P2P_LINE: what reaches the Discovery panel's Activity feed.
const P2P_LINE = /^\[(discovery-|p2p-sidecar)/;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const coded = (code, message = `${code} happened`) => Object.assign(new Error(message), { code });

let testRoot, fakeDir, peerDir, registryFile;
let config, catalog, discoveryP2p, peerDbs, logger, createPeerAdder, peerAdder;

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-peer-add-'));
  const dbDirectory = path.join(testRoot, 'db');
  fakeDir = path.join(testRoot, 'fake-blobs');
  peerDir = path.join(dbDirectory, 'discovery-peers');
  registryFile = path.join(dbDirectory, 'discovery-p2p', 'peer-dbs.json');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory,
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    port: 0,
  }));
  // The real log rings, console silenced: the wired tests read the
  // Activity feed itself.
  logger = await import('../../src/logger.js');
  for (const t of winston.default.transports) {
    if (t instanceof winston.transports.Console) { t.silent = true; }
  }
  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  // 1 MiB: config's minimum is 10, but nothing re-validates a live edit.
  Object.assign(config.program.discoveryP2p, { maxPeerDbStorageMb: 1, autoFetch: false });
  catalog = await import('../../src/state/discovery-catalog.js');
  discoveryP2p = await import('../../src/state/discovery-p2p.js');
  peerDbs = await import('../../src/state/discovery-peer-dbs.js');
  ({ createPeerAdder, peerAdder } = await import('../../src/state/discovery-peer-add.js'));
});

after(() => {
  delete process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR;
  delete process.env.MSTREAM_TEST_P2P_NO_SIDECAR;
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
});

// ── An adder over fakes ─────────────────────────────────────────────────────

function harness() {
  const t = {
    clock: Date.parse('2026-10-27T10:00:00.000Z'),
    blocked: new Set(),
    catalog: new Map(),
    shelf: new Map(),
    seeders: new Map(),
    plans: new Map(),     // endpointId -> planRoomFor answer (default: fits, nothing to evict)
    planCalls: [],
    fetches: [],          // { endpointId, opts, resolve, reject }, in call order
    running: true,
    model: null,
    lines: [],
    shelfListeners: new Set(),
    stopListeners: new Set(),
  };
  const log = (level) => (message) => t.lines.push({ level, message });
  t.adder = createPeerAdder({
    fetchPeer: (endpointId, opts) => new Promise((resolve, reject) => {
      t.fetches.push({ endpointId, opts, resolve, reject });
    }),
    planRoomFor: (endpointId) => {
      t.planCalls.push(endpointId);
      if (!t.catalog.has(endpointId)) { return null; }
      return t.plans.get(endpointId) || { fits: true, evictIds: [] };
    },
    isBlocked: (endpointId) => t.blocked.has(endpointId),
    heldEntry: (endpointId) => t.shelf.get(endpointId) || null,
    listShelf: () => [...t.shelf.values()],
    catalogEntry: (endpointId) => t.catalog.get(endpointId) || null,
    listCatalog: () => [...t.catalog.values()],
    seederCountOf: (hash) => t.seeders.get(hash) || 0,
    localModel: () => t.model,
    isRunning: () => t.running,
    onlineWindowMs: () => 90 * 1000,
    onShelfChange: (fn) => { t.shelfListeners.add(fn); return () => t.shelfListeners.delete(fn); },
    onStop: (fn) => { t.stopListeners.add(fn); return () => t.stopListeners.delete(fn); },
    now: () => t.clock,
    logger: { info: log('info'), warn: log('warn'), debug: log('debug') },
  });
  t.announce = (ch, { name = `Peer ${ch}`, heardAgoMs = 0, modelId = MODEL } = {}) => {
    t.catalog.set(id(ch), {
      from: id(ch),
      updatedAt: new Date(t.clock - heardAgoMs).toISOString(),
      payload: { name, hash: hashOf(ch), modelId, rowCount: 10, size: 1000 },
    });
  };
  t.hold = (ch) => t.shelf.set(id(ch), { endpointId: id(ch), name: `Peer ${ch}`, pinned: false, sizeBytes: 1000 });
  t.add = (ch, by = 'admin') => t.adder.add(id(ch), { by });
  t.state = (ch) => t.adder.stateOf(id(ch));
  t.fetchesOf = (ch) => t.fetches.filter((f) => f.endpointId === id(ch));
  t.land = async (ch, record = { rowCount: 1234, sizeBytes: 3 * 1048576 }) => {
    t.fetchesOf(ch).at(-1).resolve({ endpointId: id(ch), ...record });
    await flush();
  };
  t.fail = async (ch, err) => {
    t.fetchesOf(ch).at(-1).reject(err);
    await flush();
  };
  t.shelfChange = (endpointId, change) => { for (const fn of t.shelfListeners) { fn({ endpointId, change }); } };
  t.stop = () => { for (const fn of t.stopListeners) { fn(); } };
  t.messages = () => t.lines.map((l) => l.message);
  return t;
}

const iso = (ms) => new Date(ms).toISOString();

describe('pre-checks: the route status table', () => {
  test('blocked is 409 before the catalog lookup, even for a peer the block route forgot', () => {
    const t = harness();
    t.blocked.add(id('a'));
    assert.deepEqual(t.add('a'), { status: 409, body: { error: 'blocked' } });
    t.announce('b');
    t.blocked.add(id('b'));
    assert.deepEqual(t.add('b'), { status: 409, body: { error: 'blocked' } });
    assert.equal(t.fetches.length, 0);
    assert.equal(t.state('a'), null, 'a refusal stores nothing');
  });

  test('a peer never heard is 404 not-in-catalog', () => {
    const t = harness();
    assert.deepEqual(t.add('a'), { status: 404, body: { error: 'not-in-catalog' } });
    assert.equal(t.state('a'), null);
  });

  test('another embedding model is 409 incompatible; with no local model yet, everyone passes', () => {
    const t = harness();
    t.model = MODEL;
    t.announce('a', { modelId: 'other-model' });
    assert.deepEqual(t.add('a'), { status: 409, body: { error: 'incompatible' } });
    t.model = null;
    assert.equal(t.add('a').status, 202);
  });

  test('a held peer is 200 done, with no download and nothing stored', () => {
    const t = harness();
    t.announce('a');
    t.hold('a');
    assert.deepEqual(t.add('a'), {
      status: 200, body: { endpointId: id('a'), state: 'done', code: null, at: iso(t.clock) },
    });
    assert.equal(t.fetches.length, 0);
    assert.equal(t.state('a'), null);
  });

  test('the network being down is 200 failed offline, stored, before any plan or download', () => {
    const t = harness();
    t.announce('a');
    t.running = false;
    assert.deepEqual(t.add('a'), {
      status: 200, body: { endpointId: id('a'), state: 'failed', code: 'offline', at: iso(t.clock) },
    });
    assert.deepEqual(t.state('a'), {
      endpointId: id('a'), state: 'failed', code: 'offline', at: iso(t.clock), by: 'admin',
    });
    assert.equal(t.planCalls.length, 0);
    assert.equal(t.fetches.length, 0);
  });

  test('a silent peer nobody seeds is offline; one live seeder makes it fetchable', () => {
    const t = harness();
    t.announce('a', { heardAgoMs: 10 * MINUTE });
    assert.equal(t.add('a').body.code, 'offline');
    t.seeders.set(hashOf('a'), 1);
    assert.equal(t.add('a').status, 202, 'a failed state is retried by the next press');
    assert.equal(t.fetches.length, 1);
  });

  test('a peer announcing no size is 200 failed bad-snapshot: no plan, no download', () => {
    const t = harness();
    for (const ch of 'ab') { t.announce(ch); }
    delete t.catalog.get(id('a')).payload.size;
    t.catalog.get(id('b')).payload.size = 0;
    for (const ch of 'ab') {
      assert.deepEqual(t.add(ch), {
        status: 200, body: { endpointId: id(ch), state: 'failed', code: 'bad-snapshot', at: iso(t.clock) },
      });
    }
    assert.equal(t.planCalls.length, 0, 'nothing to plan room for');
    assert.equal(t.fetches.length, 0);
  });

  test('no room is 200 failed no-room, stored, and nothing downloads', () => {
    const t = harness();
    t.announce('a');
    t.plans.set(id('a'), { fits: false });
    assert.deepEqual(t.add('a').body, { endpointId: id('a'), state: 'failed', code: 'no-room', at: iso(t.clock) });
    assert.equal(t.state('a').code, 'no-room');
    assert.equal(t.fetches.length, 0);
  });

  test('a fit is 202 adding: one unpinned download carrying the plan as its discount', () => {
    const t = harness();
    t.announce('a');
    t.plans.set(id('a'), { fits: true, evictIds: [id('x'), id('y')] });
    assert.deepEqual(t.add('a'), {
      status: 202, body: { endpointId: id('a'), state: 'adding', code: null, at: iso(t.clock) },
    });
    assert.equal(t.fetches.length, 1);
    assert.deepEqual(t.fetches[0].opts, { pinned: false, discount: [id('x'), id('y')] },
      'fetch first: the evictees leave in the landing, never before it');
  });

  test('a second press while adding is 202 and joins: still one download', () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    t.clock += 1000;
    const again = t.add('a', 'other-admin');
    assert.equal(again.status, 202);
    assert.equal(again.body.at, iso(t.clock - 1000), 'the original state, not a new one');
    assert.equal(t.fetches.length, 1);
    assert.equal(t.state('a').by, 'admin');
  });
});

describe('transitions', () => {
  test('adding → done', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    t.clock += 5000;
    await t.land('a');
    assert.deepEqual(t.state('a'), {
      endpointId: id('a'), state: 'done', code: null, at: iso(t.clock), by: 'admin',
    });
  });

  test('adding → failed{code}, then a press (Try again) → adding with a fresh download', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    await t.fail('a', coded('offline', 'p2p-sidecar request timed out (fetch)'));
    assert.equal(t.state('a').state, 'failed');
    assert.equal(t.state('a').code, 'offline');
    assert.equal(t.add('a').status, 202);
    assert.equal(t.state('a').state, 'adding');
    assert.equal(t.fetches.length, 2);
  });

  test('a press after the landing answers the stored done', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    const landedAt = t.clock + 2000;
    t.clock = landedAt;
    await t.land('a');
    t.hold('a');
    t.clock += MINUTE;
    assert.deepEqual(t.add('a'), {
      status: 200, body: { endpointId: id('a'), state: 'done', code: null, at: iso(landedAt) },
    });
  });
});

describe('lifetimes (checked on read)', () => {
  test('done lasts 5 min, failed 30 min, adding until it settles', async () => {
    const t = harness();
    t.announce('d');
    t.announce('f');
    t.announce('s');
    t.add('d');
    await t.land('d');
    t.plans.set(id('f'), { fits: false });
    t.add('f');
    t.add('s');
    const start = t.clock;

    t.clock = start + 5 * MINUTE - 1;
    assert.equal(t.state('d').state, 'done');
    t.clock = start + 5 * MINUTE;
    assert.equal(t.state('d'), null, 'done is gone at 5 min');

    t.clock = start + 30 * MINUTE - 1;
    assert.equal(t.state('f').code, 'no-room');
    t.clock = start + 30 * MINUTE;
    assert.equal(t.state('f'), null, 'failed is gone at 30 min');

    t.clock = start + 24 * 60 * MINUTE;
    assert.equal(t.state('s').state, 'adding', 'a running download never expires');
  });

  test('a done state never refuses a press: a peer rotated off the shelf again is added afresh', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    await t.land('a');
    t.clock += MINUTE;
    t.announce('a');
    assert.equal(t.add('a').status, 202);
    assert.equal(t.fetches.length, 2);
  });
});

describe('at most 200 states', () => {
  test('the oldest outcomes go first; running downloads keep their state', () => {
    const t = harness();
    t.announce('a');
    t.announce('b');
    t.add('a');
    t.add('b');
    t.running = false;
    const ids = [];
    for (let i = 0; i < 205; i += 1) {
      const peer = i.toString(16).padStart(64, '0');
      ids.push(peer);
      t.catalog.set(peer, { from: peer, updatedAt: iso(t.clock), payload: { name: '', hash: `h${i}`, modelId: MODEL } });
      t.clock += 1;
      t.adder.add(peer, { by: 'admin' });
    }
    assert.equal(t.state('a').state, 'adding');
    assert.equal(t.state('b').state, 'adding');
    const kept = ids.filter((peer) => t.adder.stateOf(peer) !== null);
    assert.equal(kept.length, 198, '200 in all, two of them running');
    assert.deepEqual(kept, ids.slice(7), 'the oldest seven outcomes were dropped');
  });
});

describe('two downloads at a time, then FIFO', () => {
  test('the third and fourth Adds queue, report adding, and start in order as slots free', async () => {
    const t = harness();
    for (const ch of 'abcd') { t.announce(ch); }
    for (const ch of 'abcd') { assert.equal(t.add(ch).status, 202); }
    assert.deepEqual(t.fetches.map((f) => f.endpointId), [id('a'), id('b')]);
    assert.equal(t.state('c').state, 'adding');
    assert.equal(t.state('d').state, 'adding');
    assert.ok(t.messages().some((m) => m.startsWith(`[discovery-peer-dbs] add ${id('c').slice(0, 12)}…`) && m.endsWith(', queued')));
    assert.ok(!t.messages().find((m) => m.includes(id('a').slice(0, 12)))?.endsWith(', queued'));

    await t.land('a');
    assert.deepEqual(t.fetches.map((f) => f.endpointId), [id('a'), id('b'), id('c')]);
    await t.fail('b', coded('offline'));
    assert.deepEqual(t.fetches.map((f) => f.endpointId), [id('a'), id('b'), id('c'), id('d')]);
  });

  test('a queued Add re-plans when it starts', async () => {
    const t = harness();
    for (const ch of 'abc') { t.announce(ch); }
    t.plans.set(id('c'), { fits: true, evictIds: [id('x')] });
    t.add('a');
    t.add('b');
    t.add('c');
    t.plans.set(id('c'), { fits: true, evictIds: [id('y')] });
    await t.land('a');
    assert.equal(t.planCalls.filter((p) => p === id('c')).length, 2, 'once to answer, once to start');
    assert.deepEqual(t.fetchesOf('c')[0].opts.discount, [id('y')], "the start's plan, not the press's");
  });

  test("a queued Add's re-checks can end it before a download; the next one starts", async () => {
    const t = harness();
    for (const ch of 'abcdefg') { t.announce(ch); }
    for (const ch of 'abcdefg') { t.add(ch); }
    t.plans.set(id('c'), { fits: false });
    t.hold('d');
    t.blocked.add(id('e'));
    t.catalog.delete(id('f'));
    await t.land('a');
    await t.land('b');
    assert.equal(t.state('c').code, 'no-room');
    assert.equal(t.state('d').state, 'done', 'landed meanwhile (reconcile, the admin panel)');
    assert.equal(t.state('e').code, 'failed', 'blocked is not a wire code');
    assert.equal(t.state('f').code, 'gone');
    assert.deepEqual(t.fetches.map((f) => f.endpointId), [id('a'), id('b'), id('g')]);
  });
});

describe('codes', () => {
  test('each shelf code maps to its wire code; the message stays in the log', async () => {
    const cases = [
      ['no-disk', 'no-disk'], ['offline', 'offline'], ['bad-snapshot', 'bad-snapshot'], ['gone', 'gone'],
      ['blocked', 'failed'], ['failed', 'failed'], ['something-new', 'failed'], [undefined, 'failed'],
    ];
    for (const [shelfCode, wire] of cases) {
      const t = harness();
      t.announce('a');
      t.add('a');
      await t.fail('a', coded(shelfCode, `raw ${shelfCode}`));
      assert.equal(t.state('a').code, wire, `${shelfCode} → ${wire}`);
      const line = t.lines.at(-1);
      assert.equal(line.level, 'warn');
      assert.equal(line.message, `[discovery-peer-dbs] add ${id('a').slice(0, 12)}… failed (${wire}): raw ${shelfCode}`);
    }
  });

  test('a stop the adder never heard of drops the state silently', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    const before = t.lines.length;
    await t.fail('a', coded('stopped'));
    assert.equal(t.state('a'), null);
    assert.equal(t.lines.length, before);
  });
});

describe('the re-plan after a no-room download', () => {
  test('no fit any more is No room', async () => {
    const t = harness();
    t.announce('a');
    t.plans.set(id('a'), { fits: true, evictIds: [id('x')] });
    t.add('a');
    t.plans.set(id('a'), { fits: false });
    await t.fail('a', coded('no-room', 'snapshot is 9 bytes on disk — over the peer-DB storage cap; rejecting'));
    assert.equal(t.state('a').code, 'no-room');
    assert.equal(t.fetches.length, 1);
  });

  test('a new fit retries once with the new evictees', async () => {
    const t = harness();
    t.announce('a');
    t.plans.set(id('a'), { fits: true, evictIds: [id('x')] });
    t.add('a');
    t.plans.set(id('a'), { fits: true, evictIds: [id('y'), id('z')] });
    await t.fail('a', coded('no-room'));
    assert.equal(t.fetches.length, 2);
    assert.deepEqual(t.fetches[1].opts, { pinned: false, discount: [id('y'), id('z')] });
    assert.equal(t.state('a').state, 'adding');
    await t.land('a');
    assert.equal(t.state('a').state, 'done');
  });

  test('a second no-room while the plan still fits is a race, not a full shelf: Try again', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    await t.fail('a', coded('no-room'));
    await t.fail('a', coded('no-room'));
    assert.equal(t.fetches.length, 2, 'one retry, no more');
    assert.equal(t.state('a').code, 'failed');
  });

  test('a peer that left the catalog meanwhile is gone', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    t.catalog.delete(id('a'));
    await t.fail('a', coded('no-room'));
    assert.equal(t.state('a').code, 'gone');
  });
});

describe('clearing on a shelf change', () => {
  test('every failed state goes, no-room included; adding and done stay', async () => {
    const t = harness();
    for (const ch of 'abcd') { t.announce(ch); }
    t.add('a');
    t.add('b');
    await t.land('b');
    t.plans.set(id('c'), { fits: false });
    t.add('c');
    t.running = false;
    t.add('d');
    assert.equal(t.state('c').code, 'no-room');
    assert.equal(t.state('d').code, 'offline');

    t.shelfChange(id('z'), 'pinned');
    assert.equal(t.state('c'), null, 'an unpin may be the room No room waited for');
    assert.equal(t.state('d'), null);
    assert.equal(t.state('a').state, 'adding');
    assert.equal(t.state('b').state, 'done');
  });

  test('a download ending without landing drops No room only: the room it held is free again', async () => {
    const t = harness();
    for (const ch of 'abc') { t.announce(ch); }
    t.add('a');
    await t.fail('a', coded('offline'));
    t.plans.set(id('b'), { fits: false });
    t.add('b');
    t.running = false;
    t.add('c');

    t.shelfChange(id('z'), 'released');
    assert.equal(t.state('b'), null, 'the plan that said No room counted the released bytes');
    assert.equal(t.state('a').code, 'offline', 'a release frees room, nothing else: Try again stays');
    assert.equal(t.state('c').code, 'offline');
  });

  test('a done state goes when its own snapshot leaves the shelf, and only then', async () => {
    const t = harness();
    for (const ch of 'ab') { t.announce(ch); }
    t.add('a');
    t.add('b');
    await t.land('a');
    await t.land('b');

    t.shelfChange(id('b'), 'removed');
    t.shelfChange(id('a'), 'pinned');
    t.shelfChange(id('a'), 'landed');
    assert.equal(t.state('a').state, 'done', "another peer's removal, a pin or a refresh keeps it");
    assert.equal(t.state('b'), null, 'B left the shelf: its row is addable again, not done');
    assert.equal(t.add('b').status, 202);
  });
});

describe('reset (onStop)', () => {
  test('states and queue go, and late results write nothing', async () => {
    const t = harness();
    for (const ch of 'abc') { t.announce(ch); }
    for (const ch of 'abc') { t.add(ch); }
    t.stop();
    for (const ch of 'abc') { assert.equal(t.state(ch), null); }
    const before = t.lines.length;
    await t.land('a');
    await t.fail('b', coded('stopped'));
    for (const ch of 'abc') { assert.equal(t.state(ch), null, `${ch} stays forgotten`); }
    assert.equal(t.lines.length, before, 'no landed or failed line from the old network');
    assert.equal(t.fetchesOf('c').length, 0, 'the queued Add never starts');
  });

  test('new Adds get fresh slots while the old downloads still run', () => {
    const t = harness();
    for (const ch of 'abc') { t.announce(ch); }
    t.add('a');
    t.add('b');
    t.stop();
    assert.equal(t.add('c').status, 202);
    assert.equal(t.fetchesOf('c').length, 1);
  });

  test('a no-room from before the reset is not retried', async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    t.stop();
    await t.fail('a', coded('no-room'));
    assert.equal(t.fetches.length, 1);
    assert.equal(t.state('a'), null);
  });
});

describe("track: the admin panel's synchronous fetch", () => {
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  test('adding while it runs, done when it lands; the promise is handed back', async () => {
    const t = harness();
    t.announce('a');
    const d = deferred();
    assert.equal(t.adder.track(id('a'), d.promise, { by: 'admin' }), d.promise);
    assert.equal(t.state('a').state, 'adding');
    assert.equal(t.add('a').status, 202, 'a page press joins it');
    assert.equal(t.fetches.length, 0);
    d.resolve({ endpointId: id('a') });
    await flush();
    assert.equal(t.state('a').state, 'done');
  });

  test('never no-room: a cap failure there reads Try again; other codes map as usual', async () => {
    const t = harness();
    for (const [code, wire] of [['no-room', 'failed'], ['offline', 'offline'], ['blocked', 'failed']]) {
      const d = deferred();
      t.adder.track(id('a'), d.promise).catch(() => {});
      d.reject(coded(code));
      await flush();
      assert.equal(t.state('a').code, wire, `${code} → ${wire}`);
    }
  });

  test("the adder's own running Add decides the state", async () => {
    const t = harness();
    t.announce('a');
    t.add('a');
    const d = deferred();
    t.adder.track(id('a'), d.promise).catch(() => {});
    d.reject(coded('no-room'));
    await flush();
    assert.equal(t.state('a').state, 'adding');
    await t.land('a');
    assert.equal(t.state('a').state, 'done');
  });

  test('a reset mid-fetch: nothing written', async () => {
    const t = harness();
    const d = deferred();
    t.adder.track(id('a'), d.promise);
    t.stop();
    d.resolve({});
    await flush();
    assert.equal(t.state('a'), null);
  });
});

describe('log lines', () => {
  test('add (label) by user, landed (tracks, size) — all on the Activity prefix', async () => {
    const t = harness();
    t.announce('a', { name: 'Basement Hi-Fi' });
    t.announce('b', { name: 'mStream' });
    t.add('a', 'sherika');
    t.add('b', 'sherika');
    await t.land('a', { rowCount: 18234, sizeBytes: 12 * 1048576 });
    await t.land('b', { rowCount: 40, sizeBytes: 300 * 1024 });
    assert.deepEqual(t.messages(), [
      `[discovery-peer-dbs] add ${id('a').slice(0, 12)}… (Basement Hi-Fi) by 'sherika'`,
      `[discovery-peer-dbs] add ${id('b').slice(0, 12)}… (mStream · bbbb) by 'sherika'`,
      `[discovery-peer-dbs] add ${id('a').slice(0, 12)}… landed (18234 tracks, 12MB)`,
      `[discovery-peer-dbs] add ${id('b').slice(0, 12)}… landed (40 tracks, 300KB)`,
    ]);
    assert.ok(t.messages().every((m) => P2P_LINE.test(m)));
  });

  test('a pre-check failure logs the press and why', () => {
    const t = harness();
    t.announce('a');
    t.running = false;
    t.add('a');
    assert.deepEqual(t.messages(), [
      `[discovery-peer-dbs] add ${id('a').slice(0, 12)}… (Peer a) by 'admin'`,
      `[discovery-peer-dbs] add ${id('a').slice(0, 12)}… failed (offline): the discovery network is not running`,
    ]);
  });
});

// ── The default instance on the real shelf ──────────────────────────────────

// A discovery snapshot of roughly `pad` bytes (the shelf validates what it
// accepts): the format marker, meta/tracks, one row, a padding table.
function makeSnapshot(file, pad) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = 1;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tracks (export_id TEXT, artist TEXT, title TEXT, model_id TEXT, embedding BLOB);
      CREATE TABLE pad (b BLOB);`);
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('embedding_model_id', MODEL);
    db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?)').run('anon:1', 'Artist', 'Title', MODEL, Buffer.alloc(16));
    if (pad > 0) { db.prepare('INSERT INTO pad VALUES (?)').run(Buffer.alloc(pad)); }
  } finally {
    db.close();
  }
  return fs.statSync(file).size;
}

describe('wired: the default instance on the real shelf', () => {
  // peer-dbs' download, swapped so the test can hold one open; it still
  // goes through discovery-p2p fetch(), i.e. the fake fetch.
  const held = new Map(); // hash -> release()
  const holdNext = new Set();
  const announced = new Set();

  async function holdableFetch(addressing, outDir, opts) {
    if (holdNext.has(addressing.hash)) {
      holdNext.delete(addressing.hash);
      await new Promise((resolve) => held.set(addressing.hash, resolve));
    }
    return discoveryP2p.fetch(addressing, outDir, opts);
  }
  async function downloading(ch) {
    for (let i = 0; i < 400 && !held.has(hashOf(ch)); i += 1) { await sleep(5); }
    assert.ok(held.has(hashOf(ch)), `download of ${ch} never started`);
  }
  function release(ch) {
    held.get(hashOf(ch))();
    held.delete(hashOf(ch));
  }
  function announce(ch, pad) {
    const blob = path.join(fakeDir, `${hashOf(ch)}.db`);
    fs.rmSync(blob, { force: true });
    const size = makeSnapshot(blob, pad);
    catalog.record(id(ch), { hash: hashOf(ch), size, snapshotSeq: 1, rowCount: 1, modelId: MODEL, name: `Peer ${ch}` });
    announced.add(id(ch));
  }
  async function shelve(ch, pad, { pinned = false } = {}) {
    announce(ch, pad);
    await peerDbs.fetchPeer(id(ch), { pinned });
  }
  const registryIds = () => JSON.parse(fs.readFileSync(registryFile, 'utf8')).map((e) => e.endpointId).sort();

  before(() => {
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = fakeDir;
    peerDbs.setFetchForTests(holdableFetch);
  });
  afterEach(async () => {
    for (const ch of [...held.keys()]) { held.get(ch)(); }
    held.clear();
    holdNext.clear();
    await peerAdder.whenIdle();
    peerAdder.reset();
    for (const e of peerDbs.list()) { peerDbs.removePeerDb(e.endpointId); }
    for (const peer of announced) { catalog.forget(peer); }
    announced.clear();
  });
  after(() => {
    peerDbs.setFetchForTests(null);
    delete process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR;
  });

  test('fetch first: the evictee stays on the shelf until the landing swaps it out in one write', async () => {
    await shelve('a', 300_000);
    await shelve('b', 300_000, { pinned: true });
    announce('c', 450_000);
    assert.deepEqual(peerDbs.planRoomFor(id('c')), { fits: true, evictIds: [id('a')] }, 'precondition');
    const cursor = logger.getP2pActivity(0).lastSeq;

    holdNext.add(hashOf('c'));
    assert.equal(peerAdder.add(id('c'), { by: 'admin' }).status, 202);
    await downloading('c');
    assert.ok(peerDbs.get(id('a')), 'nothing leaves before the download is in hand');
    assert.deepEqual(registryIds(), [id('a'), id('b')]);
    assert.equal(peerAdder.stateOf(id('c')).state, 'adding');

    release('c');
    await peerAdder.whenIdle();
    assert.equal(peerAdder.stateOf(id('c')).state, 'done');
    assert.deepEqual(registryIds(), [id('b'), id('c')]);
    assert.equal(peerDbs.get(id('c')).pinned, false, 'a page Add never pins');

    const lines = logger.getP2pActivity(cursor).entries.map((e) => e.message);
    const c12 = `${id('c').slice(0, 12)}…`;
    assert.ok(lines.includes(`[discovery-peer-dbs] add ${c12} (Peer c) by 'admin'`), lines.join('\n'));
    assert.ok(lines.includes(`[discovery-peer-dbs] add ${c12} swapped out ${id('a').slice(0, 12)}…`));
    assert.ok(lines.some((l) => l.startsWith(`[discovery-peer-dbs] add ${c12} landed (1 tracks, `)));
  });

  test('an evictee already gone by the landing: the Add still lands', async () => {
    await shelve('a', 300_000);
    await shelve('b', 300_000, { pinned: true });
    announce('c', 450_000);
    holdNext.add(hashOf('c'));
    peerAdder.add(id('c'), { by: 'admin' });
    await downloading('c');
    peerDbs.removePeerDb(id('a'));
    release('c');
    await peerAdder.whenIdle();
    assert.equal(peerAdder.stateOf(id('c')).state, 'done');
    assert.deepEqual(registryIds(), [id('b'), id('c')]);
  });

  test('No room until an unpin, which clears it; then the Add swaps the unpinned one out', async () => {
    await shelve('a', 300_000, { pinned: true });
    await shelve('b', 300_000, { pinned: true });
    announce('c', 450_000);
    const first = peerAdder.add(id('c'), { by: 'admin' });
    assert.equal(first.status, 200);
    assert.equal(first.body.code, 'no-room');
    assert.equal(peerAdder.stateOf(id('c')).code, 'no-room');

    peerDbs.setPinned(id('a'), false);
    assert.equal(peerAdder.stateOf(id('c')), null, 'the pin change cleared it');
    assert.equal(peerAdder.add(id('c'), { by: 'admin' }).status, 202);
    await peerAdder.whenIdle();
    assert.deepEqual(registryIds(), [id('b'), id('c')]);
  });

  test('a No room decided while another Add held the room clears when that Add fails', async () => {
    await shelve('p', 500_000, { pinned: true });
    await shelve('v', 400_000);
    announce('a', 400_000);
    announce('b', 300_000);
    holdNext.add(hashOf('a'));
    assert.equal(peerAdder.add(id('a'), { by: 'admin' }).status, 202);
    await downloading('a');
    assert.equal(peerAdder.add(id('b'), { by: 'admin' }).body.code, 'no-room', "V is A's to swap out");

    const failFile = path.join(fakeDir, `${hashOf('a')}.fail`);
    fs.writeFileSync(failFile, '');
    try {
      release('a');
      await peerAdder.whenIdle();
    } finally {
      fs.rmSync(failFile, { force: true });
    }
    assert.equal(peerAdder.stateOf(id('a')).code, 'offline');
    assert.equal(peerAdder.stateOf(id('b')), null, 'V is free again, so B is no longer No room');
    assert.equal(peerAdder.add(id('b'), { by: 'admin' }).status, 202);
    await peerAdder.whenIdle();
    assert.equal(peerAdder.stateOf(id('b')).state, 'done');
    assert.deepEqual(registryIds(), [id('b'), id('p')]);
  });

  test('the stack stopping mid-download: the state is gone, and nothing lands', async () => {
    await shelve('a', 300_000);
    await shelve('b', 300_000, { pinned: true });
    announce('c', 450_000);
    holdNext.add(hashOf('c'));
    peerAdder.add(id('c'), { by: 'admin' });
    await downloading('c');
    const registryBefore = fs.readFileSync(registryFile, 'utf8');

    peerDbs.stopAutoFetch();
    assert.equal(peerAdder.stateOf(id('c')), null);
    release('c');
    await peerAdder.whenIdle();
    assert.equal(fs.readFileSync(registryFile, 'utf8'), registryBefore, 'the registry is not written');
    assert.equal(peerAdder.stateOf(id('c')), null, 'no late state either');
    assert.ok(!fs.existsSync(path.join(peerDir, `${hashOf('c').slice(0, 16)}.db`)), 'the download was discarded');

    assert.equal(peerAdder.add(id('c'), { by: 'admin' }).status, 202, 'the next network starts clean');
    await peerAdder.whenIdle();
    assert.equal(peerAdder.stateOf(id('c')).state, 'done');
  });
});

// ── discovery-p2p.js test switches ──────────────────────────────────────────

describe('discovery-p2p test switches', () => {
  const blobDir = () => path.join(testRoot, 'switch-blobs');
  const outDir = () => path.join(testRoot, 'switch-out');
  let blobSize;

  before(() => {
    fs.mkdirSync(blobDir(), { recursive: true });
    blobSize = makeSnapshot(path.join(blobDir(), `${hashOf('s')}.db`), 1000);
    fs.writeFileSync(path.join(blobDir(), `${hashOf('t')}.fail`), '');
    fs.writeFileSync(path.join(blobDir(), `${hashOf('t')}.delay-ms`), '150\n');
  });
  afterEach(() => {
    delete process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR;
    delete process.env.MSTREAM_TEST_P2P_NO_SIDECAR;
    fs.rmSync(outDir(), { recursive: true, force: true });
  });

  test('canFetch: only a running sidecar, or the fake fetch', () => {
    assert.equal(discoveryP2p.canFetch(), false);
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = blobDir();
    assert.equal(discoveryP2p.canFetch(), true);
    assert.equal(discoveryP2p.isRunning(), false, 'the stack itself still reads as down');
  });

  test('the fake fetch lands <hash>.db where the sidecar exports it, without starting one', async () => {
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = blobDir();
    const got = await discoveryP2p.fetch({ hash: hashOf('s'), provider: id('s') }, outDir(),
      { maxBytes: blobSize, hold: true });
    const dest = path.join(outDir(), `${hashOf('s').slice(0, 16)}.db`);
    assert.deepEqual(got, { hash: hashOf('s'), size: blobSize, path: dest });
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(blobDir(), `${hashOf('s')}.db`)));
    assert.equal(discoveryP2p.isRunning(), false);
  });

  test('<hash>.fail rejects like an unreachable provider, after <hash>.delay-ms', async () => {
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = blobDir();
    const started = Date.now();
    await assert.rejects(discoveryP2p.fetch({ hash: hashOf('t'), provider: id('t') }, outDir()),
      { message: 'fetch failed: dial timed out' });
    assert.ok(Date.now() - started >= 140, 'the delay ran first');
    assert.ok(!fs.existsSync(outDir()), 'nothing landed');
  });

  test('maxBytes is a ceiling: nothing lands past it', async () => {
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = blobDir();
    await assert.rejects(discoveryP2p.fetch({ hash: hashOf('s'), provider: id('s') }, outDir(),
      { maxBytes: blobSize - 1 }), /over the \d+-byte ceiling/);
    assert.ok(!fs.existsSync(outDir()));
  });

  test('a blob the dir does not hold reads as no provider', async () => {
    process.env.MSTREAM_TEST_P2P_FAKE_FETCH_DIR = blobDir();
    await assert.rejects(discoveryP2p.fetch({ hash: hashOf('u'), provider: id('u') }, outDir()), /no provider/);
  });

  test('NO_SIDECAR: no binary resolves, and start() refuses before acquiring one', async () => {
    process.env.MSTREAM_TEST_P2P_NO_SIDECAR = '1';
    assert.equal(discoveryP2p.resolveSidecarBinary(), null);
    await assert.rejects(discoveryP2p.start(), /MSTREAM_TEST_P2P_NO_SIDECAR/);
    assert.equal(discoveryP2p.isRunning(), false);
  });
});
