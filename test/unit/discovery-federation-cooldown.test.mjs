/**
 * The federation fan-out's peer cool-down (src/api/discovery-federation.js):
 * a peer whose dial fails twice in a row is not dialed again for a
 * while, so one offline paired server stops costing every Discover call its
 * whole 4 s deadline. The rules alone, with an injected clock and fake
 * dial/read — no server, no iroh: createPeerFailureMemory's arithmetic and
 * settlePeers' choice of which failures count. Plus fanOutFederation itself
 * in this process, whose federation endpoint never started — the boot
 * window, where a failed dial must not count as a miss. The real fan-out
 * against a stopped peer is covered by the integration suite
 * (discovery-taste-federation, its last test).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import winston from 'winston';

import {
  createPeerFailureMemory, settlePeers, mergePeerAnswers, peerFailures, fanOutFederation,
  PEER_MISSES_BEFORE_COOLDOWN, PEER_RETRY_AFTER_MS, PEER_RETRY_MAX_MS,
} from '../../src/api/discovery-federation.js';
import * as config from '../../src/state/config.js';
import * as dbManager from '../../src/db/manager.js';
import * as fedDb from '../../src/db/federation.js';
import { getEndpointId } from '../../src/state/federation.js';

const RETRY = 1000;
const MAX = 8000;
const T0 = Date.parse('2026-10-17T12:00:00Z');

const none = () => ({ mbids: new Set(), artistTitles: new Set(), artists: new Set() });
const peerRow = (id, name = `P${id}`) => ({ id, name, last_seen: null, use_discovery: 1 });

// A fake network: per peer id, what the next dial does — 'ok' answers 200,
// 'down' throws like a missed deadline, 'forbidden' answers 403 — and a log
// of every dial made.
function fakeNet() {
  const behaviour = new Map();
  const dialed = [];
  return {
    set(id, how) { behaviour.set(id, how); },
    dialed,
    dial(peer) {
      dialed.push(peer.id);
      const how = behaviour.get(peer.id) || 'ok';
      if (how === 'down') { return Promise.reject(new Error('no answer within 4000ms (dial included)')); }
      return Promise.resolve({ ok: how === 'ok', status: how === 'ok' ? 200 : 403, body: { results: [] } });
    },
    read(_peer, r) {
      if (!r.ok) { return Promise.reject(new Error(`http ${r.status}`)); }
      return Promise.resolve({ body: r.body, at: T0 });
    },
  };
}

describe('discovery federation: the peer cool-down', () => {
  // One fixture per test: a memory with small numbers, a clock and a net.
  function setup() {
    let t = T0;
    const clock = {
      now: () => t,
      advance(ms) { t += ms; },
    };
    const failures = createPeerFailureMemory({ retryAfterMs: RETRY, maxRetryMs: MAX, missesBeforeCooldown: 2 });
    const net = fakeNet();
    const settle = (peers, extra = {}) => settlePeers(peers, {
      dial: net.dial, read: net.read, failures, now: clock.now, ...extra,
    });
    return { clock, failures, net, settle };
  }

  test('a healthy peer is dialed and read', async () => {
    const { net, settle } = setup();
    const [outcome] = await settle([peerRow(1)]);
    assert.equal(outcome.status, 'fulfilled');
    assert.deepEqual(outcome.value, { body: { results: [] }, at: T0 });
    assert.deepEqual(net.dialed, [1]);
  });

  test('one miss is not proof: the peer is dialed next time; the second parks it', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');

    const [first] = await settle(peers);
    assert.equal(first.status, 'rejected');
    assert.match(first.reason.message, /no answer within/);
    assert.equal(first.reason.parkedMs, undefined, 'miss 1 parks nothing');
    assert.equal(failures.coolingDown(1, clock.now()), false);

    const [second] = await settle(peers);
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.parkedMs, RETRY, 'miss 2 parks it for retryAfterMs');
    assert.match(second.reason.message, /no answer within/, 'the dial\'s own reason, for the log');
    assert.equal(failures.coolingDown(1, clock.now()), true);
    assert.deepEqual(net.dialed, [1, 1]);

    // Parked: not dialed, rejected at once, and the merge counts it unreachable.
    const outcomes = await settle(peers);
    assert.deepEqual(net.dialed, [1, 1], 'a parked peer is not dialed');
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[0].reason.coolingDown, true);
    assert.match(outcomes[0].reason.message, /cool-down/);
    const merged = mergePeerAnswers(peers, outcomes, { excludeSets: none(), limit: 10 });
    assert.deepEqual(merged.searched, { peers: 0, unreachable: 1, mismatched: 0 });
    assert.equal(merged.peers[0].reachable, false);
    assert.deepEqual(merged.peers[0].results, []);
  });

  test('after the cool-down it is dialed again; each further miss doubles the next one, up to the cap', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);
    await settle(peers);            // miss 2 → parked RETRY

    clock.advance(RETRY - 1);
    await settle(peers);
    assert.equal(net.dialed.length, 2, 'still parked 1 ms before the end');

    clock.advance(1);
    const [third] = await settle(peers);
    assert.equal(net.dialed.length, 3, 'dialed again once the cool-down is over');
    assert.equal(third.reason.parkedMs, 2 * RETRY, 'miss 3 parks it for twice as long');
    clock.advance(2 * RETRY - 1);
    assert.equal(failures.coolingDown(1, clock.now()), true);
    clock.advance(1);
    assert.equal(failures.coolingDown(1, clock.now()), false);

    // Misses 4, 5, 6, 7: 4×, 8× (= MAX), then the cap holds.
    const parked = [];
    for (let i = 0; i < 4; i++) {
      const [o] = await settle(peers);
      parked.push(o.reason.parkedMs);
      clock.advance(o.reason.parkedMs);
    }
    assert.deepEqual(parked, [4 * RETRY, MAX, MAX, MAX]);
    assert.equal(net.dialed.length, 7, 'one probe per cool-down, never one per call');
  });

  test('an answer clears everything: the next miss is miss 1 again', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);
    await settle(peers);
    clock.advance(RETRY);

    net.set(1, 'ok');
    const [back] = await settle(peers);
    assert.equal(back.status, 'fulfilled');

    net.set(1, 'down');
    const [again] = await settle(peers);
    assert.equal(again.reason.parkedMs, undefined, 'miss 1 again: not parked');
    assert.equal(failures.coolingDown(1, clock.now()), false);
    const [twice] = await settle(peers);
    assert.equal(twice.reason.parkedMs, RETRY, 'and the backoff starts over');
  });

  test('a non-OK answer (the peer\'s 403) rejects but is no miss — and it clears an earlier miss', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);            // miss 1

    net.set(1, 'forbidden');
    for (let i = 0; i < 2; i++) {
      const [o] = await settle(peers);
      assert.equal(o.status, 'rejected');
      assert.equal(o.reason.message, 'http 403');
      assert.equal(o.reason.parkedMs, undefined);
      assert.equal(o.reason.coolingDown, undefined);
      assert.equal(failures.coolingDown(1, clock.now()), false, 'answered: never parked');
    }
    assert.deepEqual(net.dialed, [1, 1, 1]);

    net.set(1, 'down');
    const [o] = await settle(peers);
    assert.equal(o.reason.parkedMs, undefined, 'the 403 cleared miss 1: this is miss 1');
  });

  test('a read that throws past the status (bad JSON) is no miss either', async () => {
    const { failures, clock } = setup();
    const peers = [peerRow(1)];
    const read = () => Promise.reject(new SyntaxError('Unexpected token < in JSON'));
    const dial = () => Promise.resolve({ ok: true });
    for (let i = 0; i < 3; i++) {
      const [o] = await settlePeers(peers, { dial, read, failures, now: clock.now });
      assert.equal(o.status, 'rejected');
      assert.ok(o.reason instanceof SyntaxError);
    }
    assert.equal(failures.coolingDown(1, clock.now()), false);
  });

  test('a dial this server could not make (notAMiss: its own endpoint is down) is no miss and leaves the count alone', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);            // a real miss: miss 1

    // fanOutFederation's dial tags this while getEndpointId() is null (boot,
    // reboot, federation just enabled).
    const localDown = () => Promise.reject(Object.assign(
      new Error('federation endpoint is not running (enable federation first)'), { notAMiss: true }));
    for (let i = 0; i < 2; i++) {
      const [o] = await settlePeers(peers, { dial: localDown, read: net.read, failures, now: clock.now });
      assert.equal(o.status, 'rejected', 'still unreachable in this call');
      assert.equal(o.reason.notAMiss, true);
      assert.equal(o.reason.parkedMs, undefined);
      assert.equal(failures.coolingDown(1, clock.now()), false, 'twice in a row: no park');
    }

    // Untouched, not cleared: the next real miss is miss 2 and parks.
    const [o] = await settle(peers);
    assert.equal(o.reason.parkedMs, RETRY);

    // And from a clean slate, any number of them park nothing.
    const fresh = createPeerFailureMemory({ retryAfterMs: RETRY, maxRetryMs: MAX, missesBeforeCooldown: 2 });
    for (let i = 0; i < 5; i++) {
      await settlePeers(peers, { dial: localDown, read: net.read, failures: fresh, now: clock.now });
    }
    assert.equal(fresh.coolingDown(1, clock.now()), false);
    assert.equal(fresh.miss(1, clock.now()), 0, 'the first real miss is miss 1');
  });

  test('forced dials a parked peer; its answer clears the cool-down for everyone', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);
    await settle(peers);
    assert.equal(failures.coolingDown(1, clock.now()), true);

    const [forcedMiss] = await settle(peers, { forced: true });
    assert.equal(net.dialed.length, 3, 'forced: dialed despite the cool-down');
    assert.equal(forcedMiss.reason.parkedMs, 2 * RETRY, 'a forced miss is still a miss');

    net.set(1, 'ok');
    const [forcedHit] = await settle(peers, { forced: true });
    assert.equal(forcedHit.status, 'fulfilled');
    assert.equal(failures.coolingDown(1, clock.now()), false);
    await settle(peers);
    assert.equal(net.dialed.length, 5, 'the unforced call dials it again');
  });

  test('forget clears a parked peer', async () => {
    const { net, failures, clock, settle } = setup();
    const peers = [peerRow(1)];
    net.set(1, 'down');
    await settle(peers);
    await settle(peers);
    assert.equal(failures.coolingDown(1, clock.now()), true);

    failures.forget(1);
    assert.equal(failures.coolingDown(1, clock.now()), false);
    const [o] = await settle(peers);
    assert.equal(net.dialed.length, 3, 'dialed right away');
    assert.equal(o.reason.parkedMs, undefined, 'and its count started over: miss 1');
  });

  test('peers are independent: A parked, B dialed in the same call, outcomes in peers order', async () => {
    const { net, settle } = setup();
    const peers = [peerRow(1, 'A'), peerRow(2, 'B'), peerRow(3, 'C')];
    net.set(1, 'down');
    net.set(3, 'forbidden');
    await settle(peers);
    await settle(peers);            // A: miss 2 → parked
    net.dialed.length = 0;

    const outcomes = await settle(peers);
    assert.deepEqual(net.dialed, [2, 3], 'only A sits out');
    assert.deepEqual(outcomes.map((o) => o.status), ['rejected', 'fulfilled', 'rejected']);
    assert.equal(outcomes[0].reason.coolingDown, true);
    assert.equal(outcomes[2].reason.message, 'http 403');
    const merged = mergePeerAnswers(peers, outcomes, { excludeSets: none(), limit: 10 });
    assert.deepEqual(merged.peers.map((p) => [p.id, p.reachable]), [[1, false], [2, true], [3, false]]);
    assert.deepEqual(merged.searched, { peers: 1, unreachable: 2, mismatched: 0 });
  });

  test('miss() returns the parked duration, 0 under the threshold; a third threshold works too', () => {
    const m = createPeerFailureMemory({ retryAfterMs: 500, maxRetryMs: 1500, missesBeforeCooldown: 3 });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => m.miss(7, T0)), [0, 0, 500, 1000, 1500, 1500]);
    assert.equal(m.coolingDown(7, T0 + 1499), true);
    assert.equal(m.coolingDown(7, T0 + 1500), false);
    assert.equal(m.coolingDown(8, T0), false, 'never missed → not cooling down');
    m.answered(7);
    assert.equal(m.miss(7, T0), 0);
  });

  test('the defaults: 2 misses, 60 s doubling to a 10 min cap; the module memory is one of them', (t) => {
    assert.equal(PEER_MISSES_BEFORE_COOLDOWN, 2);
    assert.equal(PEER_RETRY_MAX_MS, 10 * 60 * 1000);
    if (process.env.MSTREAM_TEST_PEER_RETRY_MS) {
      t.diagnostic('MSTREAM_TEST_PEER_RETRY_MS is set: the 60 s default is not in effect here');
    } else {
      assert.equal(PEER_RETRY_AFTER_MS, 60 * 1000);
    }
    const m = createPeerFailureMemory();
    const parked = Array.from({ length: 8 }, () => m.miss(1, T0));
    const r = PEER_RETRY_AFTER_MS;
    assert.deepEqual(parked, [0, r, 2 * r, 4 * r, 8 * r, 16 * r, 32 * r, 64 * r].map((ms) => Math.min(ms, PEER_RETRY_MAX_MS)));
    for (const k of ['coolingDown', 'miss', 'answered', 'forget']) {
      assert.equal(typeof peerFailures[k], 'function', `peerFailures.${k}`);
    }
  });
});

// fanOutFederation for real, in a process whose federation endpoint never
// started: what a caller sees at boot while the endpoint binds after HTTP is
// already serving, after a reboot stops it, or right after federation is
// switched on. connectToPeer throws at once (no native module is loaded), and
// those failures must not park the peer.
describe('discovery federation: no miss while this server\'s own endpoint is down', () => {
  let tmpDir;
  let peerId;
  // The boot below logs every migration; keep the suite's output readable.
  const quiet = new winston.transports.Console({ silent: true });
  before(async () => {
    winston.add(quiet);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fed-cooldown-'));
    const dbDirectory = path.join(tmpDir, 'db');
    fs.mkdirSync(dbDirectory);
    const configFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ storage: { dbDirectory } }));
    await config.setup(configFile);
    dbManager.initDB();
    const peer = fedDb.addFederationPeer({ name: 'B', endpointTicket: 'never-parsed', apiKey: 'fedk_test' });
    fedDb.setFederationPeerUseDiscovery(peer.id, true);
    peerId = peer.id;
  });
  after(() => {
    try { dbManager.close(); } catch { /* noop */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    winston.remove(quiet);
  });

  test('every call dials, reports the peer unreachable, and parks nothing', async () => {
    assert.equal(getEndpointId(), null, 'precondition: no federation endpoint in this process');
    const failures = createPeerFailureMemory({ retryAfterMs: RETRY, maxRetryMs: MAX, missesBeforeCooldown: 2 });
    const calls = { coolingDown: 0, miss: 0 };
    const counting = {
      ...failures,
      coolingDown(id, now) { calls.coolingDown += 1; return failures.coolingDown(id, now); },
      miss(id, now) { calls.miss += 1; return failures.miss(id, now); },
    };
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const out = await fanOutFederation(new Float32Array([1, 0, 0]), 'test-model', { failures: counting, now: () => T0 });
      assert.ok(Date.now() - t0 < 1000, 'fails at once, no deadline wait');
      assert.deepEqual(out.searched, { peers: 0, unreachable: 1, mismatched: 0 });
      assert.equal(out.peers[0].id, peerId);
      assert.equal(out.peers[0].reachable, false);
      assert.equal(failures.coolingDown(peerId, T0), false, `call ${i + 1}: not parked`);
    }
    assert.equal(calls.coolingDown, 3, 'considered on every call');
    assert.equal(calls.miss, 0, 'never counted as a miss');
    assert.equal(failures.miss(peerId, T0), 0, 'so the first real miss is miss 1');
  });
});
