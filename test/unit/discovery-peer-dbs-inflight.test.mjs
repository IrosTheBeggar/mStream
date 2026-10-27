/**
 * The shelf's in-flight bookkeeping (src/state/discovery-peer-dbs.js):
 *
 *   - one download per peer: a second caller joins the first (and still
 *     pins when asked), and shares its failure
 *   - reservations: a download in flight counts against the cap for every
 *     other admission, for reconcile's top-up (slot AND bytes, and it is
 *     never a candidate twice) and for rotation's plan
 *   - an Add's `discount`: the evictees leave in the same registry write that
 *     shelves the newcomer, and planRoomFor never plans away what another
 *     download is already swapping out
 *   - the stop epoch: a download running when the stack stops lands nowhere
 *   - coded errors, onShelfChange / onStop, the boot orphan sweep
 *
 * The sidecar download is replaced by a fake the test can hold open
 * (setFetchForTests), so reconcile() and rotatePeerDbs() can be watched
 * around a download that has not landed yet. The integration suite cannot
 * get here: auto-fetch only starts once a sidecar is up
 * (discovery-p2p-stack.js), and CI has none.
 *
 * Strategy: real modules against a temp dbDirectory, no server. The catalog
 * is filled through its own record(); every snapshot is a real SQLite file
 * (the shelf validates what it accepts), announced at its exact size. The
 * disk-floor override is captured at import, so it is set first.
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';

process.env.MSTREAM_TEST_DISCOVERY_DISK_FLOOR_BYTES = '1';

const MODEL = 'test-model';
const DAY = 24 * 60 * 60 * 1000;
const CAP_MB = 1; // config min is 10, but nothing re-validates a live edit
const id = (ch) => ch.repeat(64);
const hashOf = (ch) => `f${ch.repeat(63)}`;

let testRoot, templateDir, peerDir, registryFile, ledgerFile;
let config, catalog, discoveryP2p, peerDbs;
const quiet = new winston.transports.Console({ silent: true });

// A discovery snapshot of roughly `pad` bytes: the format marker, the
// meta/tracks tables the shelf checks for, one row, and a padding table.
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

// The fake sidecar download. Lands at once (a copy of the peer's template
// into the shelf directory, named like the sidecar's export) unless the
// hash is in holdNext — then it waits for release() / failHeld().
const fake = { calls: [], held: new Map(), holdNext: new Set(), failNext: new Map() };
const templates = new Map(); // hash -> template file

async function fakeFetch(addressing, outDir) {
  const { hash } = addressing;
  fake.calls.push(hash);
  if (fake.failNext.has(hash)) {
    const err = fake.failNext.get(hash);
    fake.failNext.delete(hash);
    throw err;
  }
  if (fake.holdNext.has(hash)) {
    fake.holdNext.delete(hash);
    await new Promise((resolve, reject) => fake.held.set(hash, { resolve, reject }));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `${hash.slice(0, 16)}.db`);
  fs.copyFileSync(templates.get(hash), dest);
  return { hash, size: fs.statSync(dest).size, path: dest };
}

const callsFor = (ch) => fake.calls.filter((h) => h === hashOf(ch)).length;

// Wait until a held download is actually sitting in the fake (fetchPeer
// awaits a real statfs before it dials).
async function downloading(ch) {
  for (let i = 0; i < 400 && !fake.held.has(hashOf(ch)); i += 1) { await sleep(5); }
  assert.ok(fake.held.has(hashOf(ch)), `download of ${ch} never started`);
}
function release(ch) {
  const h = fake.held.get(hashOf(ch));
  fake.held.delete(hashOf(ch));
  h.resolve();
}
function failHeld(ch, err) {
  const h = fake.held.get(hashOf(ch));
  fake.held.delete(hashOf(ch));
  h.reject(err);
}

// A catalog peer (heard just now, so online) whose snapshot is ~pad bytes.
const announced = new Set();
function announce(ch, pad, { rowCount = 10 } = {}) {
  const hash = hashOf(ch);
  const file = path.join(templateDir, `${hash}.db`);
  fs.rmSync(file, { force: true });
  const size = makeSnapshot(file, pad);
  templates.set(hash, file);
  catalog.record(id(ch), { hash, size, snapshotSeq: 1, rowCount, modelId: MODEL, name: `Peer ${ch}` });
  announced.add(id(ch));
  return size;
}

// Put a peer on the shelf for real. `ageDays` back-dates its membership:
// rotation reads the registry's own objects, so aging one in place stands
// in for a week on the shelf.
async function shelve(ch, pad, { pinned = false, ageDays = 0 } = {}) {
  announce(ch, pad);
  const record = await peerDbs.fetchPeer(id(ch), { pinned });
  if (ageDays > 0) { record.firstFetchedAt = new Date(Date.now() - ageDays * DAY).toISOString(); }
  return record;
}

const registryIds = () => JSON.parse(fs.readFileSync(registryFile, 'utf8')).map((e) => e.endpointId);

before(async () => {
  winston.add(quiet);
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-peer-inflight-'));
  const dbDirectory = path.join(testRoot, 'db');
  templateDir = path.join(testRoot, 'templates');
  peerDir = path.join(dbDirectory, 'discovery-peers');
  registryFile = path.join(dbDirectory, 'discovery-p2p', 'peer-dbs.json');
  ledgerFile = path.join(dbDirectory, 'discovery-p2p', 'rotation.json');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.mkdirSync(peerDir, { recursive: true });
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory,
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
    },
    port: 0,
  }));

  // The boot state the sweep test reads: one held snapshot, one file the
  // registry never named (a download killed before its registry write), and
  // a file that is not a snapshot at all.
  const heldFile = path.join(peerDir, 'held.db');
  const heldSize = makeSnapshot(heldFile, 0);
  makeSnapshot(path.join(peerDir, 'orphan.db'), 0);
  fs.writeFileSync(path.join(peerDir, 'notes.txt'), 'not a snapshot');
  fs.writeFileSync(registryFile, JSON.stringify([{
    endpointId: id('0'), hash: hashOf('0'), path: heldFile, snapshotSeq: 1, modelId: MODEL,
    rowCount: 1, sizeBytes: heldSize, name: 'Held', fetchedAt: new Date().toISOString(),
  }]));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  Object.assign(config.program.discoveryP2p, {
    maxPeerDbStorageMb: CAP_MB, autoFetch: true, autoFetchCount: 3, rotationDays: 7,
  });
  catalog = await import('../../src/state/discovery-catalog.js');
  discoveryP2p = await import('../../src/state/discovery-p2p.js');
  peerDbs = await import('../../src/state/discovery-peer-dbs.js');
  peerDbs.setFetchForTests(fakeFetch);
});

afterEach(() => {
  for (const h of fake.held.values()) { h.reject(new Error('test over')); }
  fake.held.clear();
  fake.holdNext.clear();
  fake.failNext.clear();
  fake.calls.length = 0;
  for (const e of peerDbs.list()) { peerDbs.removePeerDb(e.endpointId); }
  for (const peer of announced) { catalog.forget(peer); }
  announced.clear();
  config.program.discoveryP2p.blockedPeers = [];
});

after(() => {
  peerDbs.setFetchForTests(null);
  winston.remove(quiet);
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
});

describe('boot', () => {
  test('the orphan sweep removes an unnamed *.db and keeps the held file and everything else', () => {
    assert.deepEqual(peerDbs.list().map((e) => e.endpointId), [id('0')]);
    assert.ok(fs.existsSync(path.join(peerDir, 'held.db')));
    assert.ok(!fs.existsSync(path.join(peerDir, 'orphan.db')), 'nothing names it, nothing would ever remove it');
    assert.ok(fs.existsSync(path.join(peerDir, 'notes.txt')), 'only *.db files are snapshots');
  });

  test('the stack-down seams are inert: forget and the holds push resolve offline', async () => {
    assert.equal(discoveryP2p.isRunning(), false);
    assert.deepEqual(await discoveryP2p.forget(hashOf('x')), { forgotten: false, offline: true });
    assert.deepEqual(await discoveryP2p.setHolds([hashOf('x')]), { set: false, offline: true });
    assert.doesNotThrow(() => peerDbs.pushHolds());
  });
});

describe('one download per peer', () => {
  test('two callers share one download, and the joiner still pins', async () => {
    announce('a', 1000);
    fake.holdNext.add(hashOf('a'));
    const first = peerDbs.fetchPeer(id('a'));
    const second = peerDbs.fetchPeer(id('a'), { pinned: true });
    await downloading('a');
    release('a');
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(callsFor('a'), 1, 'one transfer for both callers');
    assert.equal(r1.endpointId, id('a'));
    assert.equal(r2.endpointId, id('a'));
    assert.equal(peerDbs.get(id('a')).pinned, true, "the admin panel's pin survives joining an Add");
  });

  test('a joiner shares the failure, coded', async () => {
    announce('b', 1000);
    fake.holdNext.add(hashOf('b'));
    const first = peerDbs.fetchPeer(id('b'));
    const second = peerDbs.fetchPeer(id('b'));
    await downloading('b');
    failHeld('b', new Error('p2p-sidecar request timed out (fetch)'));
    for (const p of [first, second]) {
      await assert.rejects(p, { code: 'offline', message: 'p2p-sidecar request timed out (fetch)' });
    }
    assert.equal(callsFor('b'), 1);
    assert.equal(peerDbs.get(id('b')), null);
  });

  test('a call after the download settled starts a new one', async () => {
    announce('c', 1000);
    await peerDbs.fetchPeer(id('c'));
    await peerDbs.fetchPeer(id('c'));
    assert.equal(callsFor('c'), 2, 'the in-flight entry is gone once it lands');
  });
});

describe('coded errors (messages unchanged)', () => {
  test('gone, blocked, failed, bad-snapshot', async () => {
    await assert.rejects(peerDbs.fetchPeer(id('9')),
      { code: 'gone', message: 'peer is not in the catalog (no announcement heard)' });

    announce('d', 1000);
    config.program.discoveryP2p.blockedPeers = [id('d')];
    await assert.rejects(peerDbs.fetchPeer(id('d')), { code: 'blocked' });
    config.program.discoveryP2p.blockedPeers = [];

    fake.failNext.set(hashOf('d'), new Error('blob store exploded'));
    await assert.rejects(peerDbs.fetchPeer(id('d')), { code: 'failed', message: 'blob store exploded' });

    // Not a snapshot at all, announced at its true size.
    const junk = templates.get(hashOf('d'));
    fs.writeFileSync(junk, 'x'.repeat(4096));
    catalog.record(id('d'), { hash: hashOf('d'), size: 4096, snapshotSeq: 2, rowCount: 1, modelId: MODEL, name: 'Peer d' });
    await assert.rejects(peerDbs.fetchPeer(id('d')), { code: 'bad-snapshot' });
    assert.ok(!fs.existsSync(path.join(peerDir, `${hashOf('d').slice(0, 16)}.db`)), 'the rejected file is removed');
  });

  test('a peer blocked during its download does not land', async () => {
    announce('e', 1000);
    fake.holdNext.add(hashOf('e'));
    const p = peerDbs.fetchPeer(id('e'));
    await downloading('e');
    config.program.discoveryP2p.blockedPeers = [id('e')];
    release('e');
    await assert.rejects(p, { code: 'blocked' });
    assert.equal(peerDbs.get(id('e')), null);
    assert.ok(!fs.existsSync(path.join(peerDir, `${hashOf('e').slice(0, 16)}.db`)));
  });
});

describe('reservations', () => {
  test("admission counts another download's announced bytes", async () => {
    announce('a', 600_000); // ~618 KB
    announce('b', 450_000); // ~467 KB: alone it fits, beside A it does not
    announce('c', 100_000); // ~119 KB: fits beside A
    fake.holdNext.add(hashOf('a'));
    const a = peerDbs.fetchPeer(id('a'));
    await downloading('a');
    await assert.rejects(peerDbs.fetchPeer(id('b')), { code: 'no-room' });
    assert.equal(callsFor('b'), 0, 'refused before dialing');
    await peerDbs.fetchPeer(id('c'));
    release('a');
    await a;
    assert.deepEqual(peerDbs.list().map((e) => e.endpointId).sort(), [id('a'), id('c')]);
  });

  test('a size-less announcement on a full shelf is refused for room, never fetched without a ceiling', async () => {
    await shelve('e', 200_000);
    const hash = hashOf('s');
    const file = path.join(templateDir, `${hash}.db`);
    fs.rmSync(file, { force: true });
    makeSnapshot(file, 1000);
    templates.set(hash, file);
    catalog.record(id('s'), { hash, snapshotSeq: 1, rowCount: 1, modelId: MODEL, name: 'Sizeless' });
    announced.add(id('s'));
    const cap = config.program.discoveryP2p.maxPeerDbStorageMb;
    config.program.discoveryP2p.maxPeerDbStorageMb = peerDbs.totalBytes() / (1024 * 1024); // exactly full
    try {
      await assert.rejects(peerDbs.fetchPeer(id('s')), { code: 'no-room' });
    } finally {
      config.program.discoveryP2p.maxPeerDbStorageMb = cap;
    }
    assert.equal(callsFor('s'), 0, 'a zero ceiling is no ceiling to the sidecar (fetch() drops it): never dialed');
  });

  test('reconcile skips an in-flight peer and counts its slot and its bytes', async () => {
    await shelve('e', 200_000);
    announce('a', 600_000, { rowCount: 9999 }); // the best candidate — but downloading
    announce('b', 400_000, { rowCount: 500 });  // fits only if A's bytes are ignored
    announce('c', 100_000, { rowCount: 100 });  // fits beside A
    announce('d', 30_000, { rowCount: 50 });    // fits, but A took the last slot
    fake.holdNext.add(hashOf('a'));
    const a = peerDbs.fetchPeer(id('a'));
    await downloading('a');

    await peerDbs.reconcile();
    assert.equal(callsFor('a'), 1, 'A is never a second target');
    assert.equal(callsFor('b'), 0, "B only fit by ignoring A's reservation");
    assert.equal(callsFor('c'), 1);
    assert.equal(callsFor('d'), 0, 'autoFetchCount 3 = E + A (arriving) + C');
    release('a');
    await a;
    assert.deepEqual(peerDbs.list().map((e) => e.endpointId).sort(), [id('a'), id('c'), id('e')]);
  });

  test("rotation's cap shrinks by the reservations, and an in-flight peer is no candidate", async () => {
    await shelve('e', 200_000, { ageDays: 30 });
    announce('a', 600_000);
    announce('r', 500_000, { rowCount: 500 }); // sorts ahead of A once A is a candidate again
    fake.holdNext.add(hashOf('a'));
    const a = peerDbs.fetchPeer(id('a'));
    await downloading('a');

    assert.equal(await peerDbs.rotatePeerDbs(), null, 'R fits only if A is ignored');
    assert.equal(callsFor('r'), 0);
    assert.ok(peerDbs.get(id('e')), 'nothing evicted');

    failHeld('a', new Error('p2p-sidecar request timed out (fetch)'));
    await assert.rejects(a, { code: 'offline' });
    const plan = await peerDbs.rotatePeerDbs();
    assert.deepEqual(plan, { evictId: id('e'), fetchId: id('r'), evictFirst: false },
      'with the reservation released, the same swap plans');
    assert.equal(peerDbs.get(id('e')), null);
    assert.ok(peerDbs.get(id('r')));
  });

  test('rotation does not plan a peer that is already downloading', async () => {
    await shelve('e', 200_000, { ageDays: 30 });
    announce('s', 10_000);
    fake.holdNext.add(hashOf('s'));
    const s = peerDbs.fetchPeer(id('s'));
    await downloading('s');
    // Planning S would join the held download and wait on it, so bound the
    // wait: a regression fails here instead of hanging the suite.
    const outcome = await Promise.race([peerDbs.rotatePeerDbs(), sleep(2000).then(() => 'joined S')]);
    assert.equal(outcome, null, 'S is the only candidate, and it is in flight');
    assert.ok(peerDbs.get(id('e')), 'no eviction for a download someone else started');
    release('s');
    await s;
    assert.equal(callsFor('s'), 1);
  });
});

describe("an Add's discount", () => {
  test('the evictees leave in the same registry write that shelves the newcomer', async () => {
    await shelve('e', 200_000);
    await shelve('p', 200_000, { pinned: true });
    announce('n', 700_000);
    const plan = peerDbs.planRoomFor(id('n'));
    assert.deepEqual(plan, { fits: true, evictIds: [id('e')] }, 'the pinned one is never planned');

    // What peer-dbs.json says at each notification: by the time anyone
    // hears of the eviction, the newcomer is already written beside it.
    const changes = [];
    const off = peerDbs.onShelfChange((c) => changes.push({ ...c, onDisk: registryIds().sort() }));
    try {
      await peerDbs.fetchPeer(id('n'), { discount: plan.evictIds });
    } finally {
      off();
    }
    assert.deepEqual(changes, [
      { endpointId: id('e'), change: 'removed', onDisk: [id('n'), id('p')] },
      { endpointId: id('n'), change: 'landed', onDisk: [id('n'), id('p')] },
    ]);
    assert.ok(!fs.existsSync(path.join(peerDir, `${hashOf('e').slice(0, 16)}.db`)), "the evictee's file is gone");
    assert.ok(JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))[id('e')], 'recorded like a rotation eviction');
    assert.ok(peerDbs.totalBytes() <= CAP_MB * 1024 * 1024);
  });

  test('without the discount the same fetch is refused for room', async () => {
    await shelve('e', 200_000);
    await shelve('p', 200_000, { pinned: true });
    announce('n', 700_000);
    await assert.rejects(peerDbs.fetchPeer(id('n')), { code: 'no-room' });
  });

  test('everything pinned: planRoomFor says fits:false', async () => {
    await shelve('e', 200_000, { pinned: true });
    await shelve('p', 200_000, { pinned: true });
    announce('n', 700_000);
    assert.deepEqual(peerDbs.planRoomFor(id('n')), { fits: false });
    assert.equal(peerDbs.planRoomFor(id('9')), null, 'not in the catalog');
  });

  test('a pin set during the download keeps the evictee, and the landing is refused for room', async () => {
    await shelve('e', 200_000);
    await shelve('p', 200_000, { pinned: true });
    announce('n', 700_000);
    const plan = peerDbs.planRoomFor(id('n'));
    fake.holdNext.add(hashOf('n'));
    const n = peerDbs.fetchPeer(id('n'), { discount: plan.evictIds });
    await downloading('n');
    peerDbs.setPinned(id('e'), true);
    release('n');
    await assert.rejects(n, { code: 'no-room' });
    assert.ok(peerDbs.get(id('e')), 'the pin wins over the plan');
    assert.equal(peerDbs.get(id('n')), null);
  });

  test('planRoomFor never plans away what another download is already swapping out', async () => {
    await shelve('e', 200_000, { ageDays: 9 }); // older: first to go
    await shelve('f', 200_000, { ageDays: 1 });
    announce('n', 700_000);
    announce('m', 300_000);
    const first = peerDbs.planRoomFor(id('n'));
    assert.deepEqual(first.evictIds, [id('e')]);
    fake.holdNext.add(hashOf('n'));
    const n = peerDbs.fetchPeer(id('n'), { discount: first.evictIds });
    await downloading('n');

    const second = peerDbs.planRoomFor(id('m'));
    assert.deepEqual(second, { fits: true, evictIds: [id('f')] }, 'E is already spoken for');
    release('n');
    await n;
    await peerDbs.fetchPeer(id('m'), { discount: second.evictIds });
    assert.deepEqual(peerDbs.list().map((e) => e.endpointId).sort(), [id('m'), id('n')]);
    assert.ok(peerDbs.totalBytes() <= CAP_MB * 1024 * 1024);
  });
});

describe('stopping', () => {
  test('a download running at stopAutoFetch lands nowhere; onStop fires; a new call starts fresh', async () => {
    announce('k', 1000);
    let stops = 0;
    const off = peerDbs.onStop(() => { stops += 1; });
    fake.holdNext.add(hashOf('k'));
    const doomed = peerDbs.fetchPeer(id('k'));
    await downloading('k');
    peerDbs.stopAutoFetch(); // never wired here: the epoch and the hook still move
    off();
    assert.equal(stops, 1);
    const fresh = peerDbs.fetchPeer(id('k')); // waits for the doomed one to give up
    release('k');
    await assert.rejects(doomed, { code: 'stopped' });
    const record = await fresh;
    assert.equal(callsFor('k'), 2, 'the fresh call did not join the doomed download');
    assert.ok(fs.existsSync(record.path), "the doomed download's discard did not take the fresh file");
    assert.deepEqual(registryIds(), [id('k')]);
  });
});

describe('onShelfChange', () => {
  test('fires on landing, pin, unpin and removal (the block route removes)', async () => {
    const changes = [];
    const off = peerDbs.onShelfChange((c) => changes.push(c.change));
    await shelve('a', 1000);
    peerDbs.setPinned(id('a'), true);
    peerDbs.setPinned(id('a'), false);
    peerDbs.removePeerDb(id('a'));
    assert.equal(peerDbs.removePeerDb(id('a')), false);
    assert.equal(peerDbs.setPinned(id('a'), true), false);
    off();
    assert.deepEqual(changes, ['landed', 'pinned', 'pinned', 'removed'], 'no-ops do not fire');
  });

  test('a download that ends without landing is released, after it stops reserving', async () => {
    announce('a', 700_000);
    announce('b', 500_000);
    const changes = [];
    const off = peerDbs.onShelfChange((c) => changes.push({ ...c, plan: peerDbs.planRoomFor(id('b')) }));
    fake.failNext.set(hashOf('a'), new Error('p2p-sidecar request timed out (fetch)'));
    try {
      await assert.rejects(peerDbs.fetchPeer(id('a')), { code: 'offline' });
      await peerDbs.fetchPeer(id('b'));
    } finally {
      off();
    }
    assert.deepEqual(changes.map((c) => [c.endpointId, c.change]), [[id('a'), 'released'], [id('b'), 'landed']]);
    assert.deepEqual(changes[0].plan, { fits: true, evictIds: [] }, 'a listener re-planning sees the room free');
  });

  test('a throwing listener does not break the shelf', async () => {
    const off = peerDbs.onShelfChange(() => { throw new Error('listener bug'); });
    try {
      const record = await shelve('a', 1000);
      assert.equal(record.endpointId, id('a'));
    } finally {
      off();
    }
  });
});

describe('onlineWindowMs', () => {
  test('defaults to the rotation window and honours the test switch', () => {
    const saved = process.env.MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS;
    try {
      delete process.env.MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS;
      assert.equal(peerDbs.onlineWindowMs(), 90 * 1000);
      process.env.MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS = '86400000';
      assert.equal(peerDbs.onlineWindowMs(), 86400000);
    } finally {
      if (saved === undefined) {
        delete process.env.MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS;
      } else {
        process.env.MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS = saved;
      }
    }
  });
});
