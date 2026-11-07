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
 *
 * And what a peer that DOES answer may hand over (a peer is untrusted): the
 * fan-out's read step (readPeerAnswer) refuses an answer sent compressed or
 * past PEER_ANSWER_MAX_BYTES — no miss, the peer answered — and the
 * fan-out itself asks for it uncompressed and reads it that way (over a
 * fake federation client); the merge looks at the first 100 rows only and
 * keeps only rows it can rank, each bounded (peerSimilarity, peerTags,
 * trimmed text, the recommendation schema's repair).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import winston from 'winston';

import {
  createPeerFailureMemory, settlePeers, mergePeerAnswers, peerFailures, fanOutFederation,
  readPeerAnswer, peerSimilarity, peerTags,
  PEER_MISSES_BEFORE_COOLDOWN, PEER_RETRY_AFTER_MS, PEER_RETRY_MAX_MS, PEER_ANSWER_MAX_BYTES,
} from '../../src/api/discovery-federation.js';
import { recommendationSchema } from '../../src/discovery-plugins/recommendation.js';
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
// A throwaway mstream.db for fanOutFederation to read its peers from, and
// the teardown that removes it. The boot logs every migration; a silent
// transport keeps the suite's output readable.
async function bootPeerDb(prefix) {
  const quiet = new winston.transports.Console({ silent: true });
  winston.add(quiet);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbDirectory = path.join(tmpDir, 'db');
  fs.mkdirSync(dbDirectory);
  const configFile = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ storage: { dbDirectory } }));
  await config.setup(configFile);
  dbManager.initDB();
  return () => {
    try { dbManager.close(); } catch { /* noop */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    winston.remove(quiet);
  };
}
// A paired server with use_discovery on; its id.
function addDiscoveryPeer(name) {
  const peer = fedDb.addFederationPeer({ name, endpointTicket: 'never-parsed', apiKey: `fedk_${name}` });
  fedDb.setFederationPeerUseDiscovery(peer.id, true);
  return peer.id;
}

describe('discovery federation: no miss while this server\'s own endpoint is down', () => {
  let teardown;
  let peerId;
  before(async () => {
    teardown = await bootPeerDb('mstream-fed-cooldown-');
    peerId = addDiscoveryPeer('B');
  });
  after(() => teardown?.());

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

// ── What an answering peer may hand over ──────────────────────────────────

// An answer the way fetch hands one over: a Response over a stream that
// counts the bytes pulled from it and whether it was let go. highWaterMark
// 0, so nothing is pulled before the reader asks. `repeat` sends the first
// chunk that many times: a peer that sends far past the cap — finite, so a
// read that never stops still ends (and fails the test) rather than hang.
// `headers` adds to the answer's (content-encoding).
function streamed({ chunks, contentLength = null, repeat = 0, headers: extra = {} }) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      const next = repeat ? (i++ < repeat ? chunks[0] : undefined) : chunks[i++];
      if (next === undefined) { c.close(); return; }
      seen.pulled += next.byteLength;
      c.enqueue(next);
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  const headers = contentLength == null ? { ...extra } : { ...extra, 'content-length': String(contentLength) };
  return { response: new Response(body, { headers }), seen };
}
const bytes = (s) => new TextEncoder().encode(s);

describe('discovery federation: a peer\'s answer is read to PEER_ANSWER_MAX_BYTES at most', () => {
  test('the cap is 1 MB', () => {
    assert.equal(PEER_ANSWER_MAX_BYTES, 1024 * 1024);
  });

  test('an answer under the cap is read whole, with or without content-length', async () => {
    const json = JSON.stringify({ results: [{ artist: 'Nova', title: 'Fits', similarity: 0.5 }] });
    for (const contentLength of [Buffer.byteLength(json), null]) {
      const { response, seen } = streamed({ chunks: [bytes(json.slice(0, 10)), bytes(json.slice(10))], contentLength });
      const out = await readPeerAnswer(peerRow(1), response);
      assert.deepEqual(out.body, JSON.parse(json));
      assert.ok(Number.isFinite(out.at), 'stamped with when it arrived');
      assert.equal(seen.pulled, Buffer.byteLength(json));
    }
    // Exactly the cap is no more than the cap.
    const { response } = streamed({ chunks: [bytes(`"${'x'.repeat(4094)}"`)] });
    assert.equal((await readPeerAnswer(peerRow(1), response, 4096)).body.length, 4094);
  });

  test('a non-OK answer is refused unread, as before', async () => {
    const r = new Response('{"error":"Forbidden"}', { status: 403 });
    await assert.rejects(readPeerAnswer(peerRow(1), r), { message: 'http 403' });
  });

  test('an answer sent compressed is refused before a byte is read, whatever its size; identity is plain', async () => {
    // The body as a runtime that inflated it would hand it over: plain
    // JSON a read would take, if it read it.
    const json = '{"results":[]}';
    for (const encoding of ['gzip', 'br', 'deflate', 'zstd', 'gzip, identity', 'GZIP']) {
      const { response, seen } = streamed({ chunks: [bytes(json)], headers: { 'content-encoding': encoding } });
      await assert.rejects(readPeerAnswer(peerRow(1), response),
        { message: `answer sent with content-encoding '${encoding.toLowerCase()}', asked for uncompressed` });
      assert.equal(seen.pulled, 0, `${encoding}: nothing read`);
      assert.equal(seen.cancelled, true, `${encoding}: the body is let go`);
    }
    for (const encoding of ['identity', ' Identity ']) {
      const { response } = streamed({ chunks: [bytes(json)], headers: { 'content-encoding': encoding } });
      assert.deepEqual((await readPeerAnswer(peerRow(1), response)).body, { results: [] }, `'${encoding}' is no compression`);
    }
  });

  test('a content-length over the cap is refused before a byte is read', async () => {
    const { response, seen } = streamed({ chunks: [bytes(' ')], repeat: 10000, contentLength: 4097 });
    await assert.rejects(readPeerAnswer(peerRow(1), response, 4096), { message: 'answer of 4097 bytes is over the 4096-byte cap' });
    assert.equal(seen.pulled, 0, 'nothing read');
    assert.equal(seen.cancelled, true, 'the body is let go');
  });

  test('without content-length (chunked), or with one that lies, the read stops at the cap and lets the rest go', async () => {
    for (const contentLength of [null, 10]) {
      const { response, seen } = streamed({ chunks: [new Uint8Array(1000).fill(0x20)], repeat: 50, contentLength });
      await assert.rejects(readPeerAnswer(peerRow(1), response, 4096),
        { message: 'answer over the 4096-byte cap (stopped reading at 5000 bytes)' });
      assert.equal(seen.pulled, 5000, 'one chunk past the cap, never the rest');
      assert.equal(seen.cancelled, true);
    }
  });

  test('the default cap: a 2.5 MB answer stops one chunk past 1 MB', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const { response, seen } = streamed({ chunks: [chunk], repeat: 40 });
    await assert.rejects(readPeerAnswer(peerRow(1), response), /over the 1048576-byte cap/);
    assert.equal(seen.pulled, PEER_ANSWER_MAX_BYTES + chunk.byteLength);
  });

  test('an over-cap answer is that peer\'s failure alone: it adds nothing, the others are kept, and it is NO miss', async () => {
    const failures = createPeerFailureMemory({ retryAfterMs: RETRY, maxRetryMs: MAX, missesBeforeCooldown: 2 });
    const peers = [peerRow(1, 'Declared'), peerRow(2, 'Chunked'), peerRow(3, 'Fine')];
    const fine = JSON.stringify({ results: [{ artist: 'Nova', title: 'Kept', similarity: 0.5, filepath: 'm/kept.mp3' }] });
    const answer = {
      1: () => streamed({ chunks: [new Uint8Array(64 * 1024).fill(0x20)], repeat: 32, contentLength: 2 * PEER_ANSWER_MAX_BYTES }).response,
      2: () => streamed({ chunks: [new Uint8Array(64 * 1024).fill(0x20)], repeat: 32 }).response,
      3: () => streamed({ chunks: [bytes(fine)] }).response,
    };
    // Both over-cap peers missed a dial once before: one more miss would park them.
    failures.miss(1, T0);
    failures.miss(2, T0);
    for (let call = 1; call <= 3; call++) {
      const outcomes = await settlePeers(peers, {
        dial: (p) => Promise.resolve(answer[p.id]()), read: readPeerAnswer, failures, now: () => T0,
      });
      assert.deepEqual(outcomes.map((o) => o.status), ['rejected', 'rejected', 'fulfilled']);
      assert.match(outcomes[0].reason.message, /^answer of 2097152 bytes is over the 1048576-byte cap$/);
      assert.match(outcomes[1].reason.message, /stopped reading/);
      for (const o of outcomes.slice(0, 2)) {
        assert.equal(o.reason.parkedMs, undefined, `call ${call}: not parked`);
        assert.equal(o.reason.coolingDown, undefined);
      }
      const merged = mergePeerAnswers(peers, outcomes, { excludeSets: none(), limit: 10 });
      assert.deepEqual(merged.peers.map((g) => [g.id, g.reachable, g.results.length]), [[1, false, 0], [2, false, 0], [3, true, 1]]);
      assert.deepEqual(merged.results.map((r) => r.title), ['Kept']);
      assert.deepEqual(merged.searched, { peers: 1, unreachable: 2, mismatched: 0 });
      for (const id of [1, 2]) { assert.equal(failures.coolingDown(id, T0), false, `call ${call}: peer ${id} dialed next time`); }
    }
    // Cleared, not merely left alone: the next real miss is miss 1.
    assert.equal(failures.miss(1, T0), 0);
    assert.equal(failures.miss(2, T0), 0);
  });
});

// fanOutFederation for real over a fake federation client: what the
// per-song route and the Discover page both read a peer's answer with.
describe('discovery federation: the fan-out asks for every answer uncompressed and reads it capped', () => {
  let teardown;
  const ids = {};
  before(async () => {
    teardown = await bootPeerDb('mstream-fed-answers-');
    for (const name of ['Chunked', 'Declared', 'Compressed', 'Fine']) { ids[name] = addDiscoveryPeer(name); }
  });
  after(() => teardown?.());

  test('an answer over the cap or compressed is that peer\'s alone, and no miss: it is dialed again next call', async () => {
    // Every answer is valid JSON with one good row: a read that took it
    // whole (r.json()) would keep that row.
    const head = (title) => `{"results":[{"artist":"Nova","title":"${title}","similarity":0.5,"filepath":"m/${title}.mp3","duration":120}],"pad":"`;
    const answers = {
      // Chunked, 1.25 MB: read until it crosses the cap.
      Chunked: () => streamed({ chunks: [bytes(head('Too Long')), ...Array(20).fill(new Uint8Array(64 * 1024).fill(0x20)), bytes('"}')] }),
      // Small, but saying it is over the cap: refused before a byte.
      Declared: () => streamed({ chunks: [bytes(`${head('Declared Too Long')}"}`)], contentLength: PEER_ANSWER_MAX_BYTES + 1 }),
      // Sent gzip although asked for identity, and inflated by the
      // runtime, as fetch hands such an answer over.
      Compressed: () => streamed({ chunks: [bytes(`${head('Inflated')}"}`)], headers: { 'content-encoding': 'gzip' } }),
      Fine: () => streamed({ chunks: [bytes(`${head('Kept')}"}`)] }),
    };
    const asked = [];
    const fedClient = {
      fedFetch(peer, apiPath, opts) {
        asked.push({ peer: peer.name, apiPath, opts });
        return Promise.resolve(answers[peer.name]().response);
      },
    };
    const failures = createPeerFailureMemory({ retryAfterMs: RETRY, maxRetryMs: MAX, missesBeforeCooldown: 2 });
    // Each missed a dial once before: one more miss would park it.
    for (const id of Object.values(ids)) { failures.miss(id, T0); }

    for (let call = 1; call <= 2; call++) {
      asked.length = 0;
      const out = await fanOutFederation(new Float32Array([1, 0, 0]), 'test-model', { fedClient, failures, now: () => T0 });
      assert.deepEqual(out.peers.map((g) => [g.name, g.reachable, g.results.map((r) => r.title)]), [
        ['Chunked', false, []],
        ['Declared', false, []],
        ['Compressed', false, []],
        ['Fine', true, ['Kept']],
      ], `call ${call}`);
      assert.deepEqual(out.searched, { peers: 1, unreachable: 3, mismatched: 0 });
      assert.deepEqual(out.results.map((r) => r.title), ['Kept']);
      assert.deepEqual(asked.map((a) => a.peer), ['Chunked', 'Declared', 'Compressed', 'Fine'], `call ${call}: every peer dialed`);
      for (const { peer, apiPath, opts } of asked) {
        assert.equal(apiPath, '/api/v1/federation/discovery/similar');
        assert.equal(opts.headers['Accept-Encoding'], 'identity', `${peer}: asked for identity`);
        assert.equal(opts.decompress, false, `${peer}: Bun hands the bytes over as sent`);
      }
    }
    // Cleared by the answer, not merely left alone: the next real miss is miss 1.
    for (const id of Object.values(ids)) { assert.equal(failures.miss(id, T0), 0); }
  });
});

describe('discovery federation: the merge keeps only rows it can rank, each one bounded', () => {
  const ok = (results) => ({ status: 'fulfilled', value: { body: { results }, at: T0 } });
  const song = (title, similarity, extra = {}) => ({
    artist: 'Nova', title, similarity, filepath: `m/${title}.mp3`, duration: 120, ...extra,
  });
  const merge = (rows) => mergePeerAnswers([peerRow(1, 'A')], [ok(rows)], { excludeSets: none(), limit: 50 });
  // Every dropped or repaired row logs a debug line; keep the output readable.
  const quiet = new winston.transports.Console({ silent: true });
  before(() => { winston.add(quiet); });
  after(() => { winston.remove(quiet); });

  test('similarity: a finite number, clamped to [-1, 1], or the row is dropped', () => {
    assert.deepEqual([0.5, -3, 1.7, 1, -1].map(peerSimilarity), [0.5, -1, 1, 1, -1]);
    for (const bad of [undefined, null, '0.5', 'high', NaN, Infinity, -Infinity, { valueOf: () => 0.5 }, [0.5], true]) {
      assert.equal(peerSimilarity(bad), null, String(bad));
    }
    const out = merge([
      song('Plain', 0.5),
      song('Absent', undefined),
      song('Null', null),
      song('Numeric String', '0.6'),
      // Past the near-duplicate check (a word is never >= 0.99) and NaN in
      // the sort's comparator, before.
      song('Word', 'high'),
      song('Not A Number', NaN),
      song('Infinite', Infinity),
      song('Object', { valueOf: () => 0.7 }),
      song('Far Below', -3),
      // Clamped to 1: a near-duplicate of the query, so out.
      song('Far Above', 1.7),
      song('Best', 0.98),
      song('Middle', 0.2),
    ]);
    assert.deepEqual(out.results.map((r) => [r.title, r.similarity]),
      [['Best', 0.98], ['Plain', 0.5], ['Middle', 0.2], ['Far Below', -1]], 'in a consistent order, best first');
  });

  test('genreTags: null, or at most 10 trimmed strings of at most 64 characters', () => {
    const huge = Array.from({ length: 10000 }, (_v, i) => `Style---${i}`);
    const out = merge([
      song('Model', 0.9, { genreTags: ['Electronic---Techno', 'Electronic---House'] }),
      song('Absent', 0.89),
      song('Null', 0.88, { genreTags: null }),
      song('String', 0.87, { genreTags: 'Rock' }),
      song('Object', 0.86, { genreTags: { 0: 'Rock', length: 1 } }),
      song('Huge', 0.85, { genreTags: huge }),
      song('Long', 0.84, { genreTags: ['x'.repeat(64), 'y'.repeat(65), 'z'.repeat(1_000_000)] }),
      song('Mixed', 0.83, {
        genreTags: [42, null, '  Jazz---Bop  ', { name: 'x' }, ['Rock'], '', '   ', true,
          'Folk, World, & Country---Canzone Napoletana'],
      }),
      song('Nothing Usable', 0.82, { genreTags: [1, 2, ''] }),
      song('Empty', 0.81, { genreTags: [] }),
    ]);
    const tags = Object.fromEntries(out.results.map((r) => [r.title, r.genreTags]));
    assert.deepEqual(tags, {
      Model: ['Electronic---Techno', 'Electronic---House'],
      Absent: null,
      Null: null,
      String: null,
      Object: null,
      Huge: huge.slice(0, 10),
      Long: ['x'.repeat(64)],
      Mixed: ['Jazz---Bop', 'Folk, World, & Country---Canzone Napoletana'],
      'Nothing Usable': null,
      Empty: null,
    });
    assert.ok(out.results.every((r) => 'genreTags' in r), 'every row carries the key, so clients read one shape');
    assert.equal(peerTags('Rock'), null);
    assert.equal(peerTags(huge).length, 10);
  });

  test('every row is one the recommendation schema takes, on the per-song route too: a bad optional fact nulled, a bad identity dropped', () => {
    const out = merge([
      song('Raw Isrc', 0.9, { isrc: 'US-RC1-76-07839', year: 99999 }),
      song('Long Title '.repeat(60), 0.85),
      song('Typed Artist', 0.84, { artist: 42 }),
      song('Long Path', 0.83, { filepath: `m/${'p'.repeat(3000)}.mp3` }),
      song('Fine', 0.8),
    ]);
    assert.deepEqual(out.results.map((r) => r.title), ['Raw Isrc', 'Fine']);
    assert.equal(out.results[0].isrc, null, 'an ISRC as a raw tag spells it');
    assert.equal(out.results[0].year, null);
    for (const r of out.results) {
      assert.equal(recommendationSchema.validate(r).error, undefined, r.title);
    }
  });

  test('padding stretches no field past its bound: text is trimmed, numbers stay numbers', () => {
    const pad = ' '.repeat(300_000);
    const out = merge([
      song('Padded', 0.9, {
        artist: `${pad}Nova${pad}`,
        title: `${pad}Padded${pad}`,
        album: `${pad}Padded Album${pad}`,
        filepath: `${pad}m/padded.mp3${pad}`,
        recordingMbid: `${pad}mbid-padded${pad}`,
        releaseGroupMbid: `${pad}rg-padded${pad}`,
        isrc: `${pad}USRC17607839${pad}`,
        // Numeric strings the schema would convert, and pass on as sent.
        year: `${pad}1999${pad}`,
        duration: `${'0'.repeat(300_000)}120`,
      }),
      song('Numbers', 0.8, { year: 1999, duration: 61.5 }),
    ]);
    const fields = ['artist', 'title', 'album', 'filepath', 'recordingMbid', 'releaseGroupMbid', 'isrc', 'year', 'duration'];
    const pick = (r) => Object.fromEntries(fields.map((k) => [k, r[k]]));
    assert.deepEqual(out.results.map(pick), [
      {
        artist: 'Nova', title: 'Padded', album: 'Padded Album', filepath: 'm/padded.mp3', recordingMbid: 'mbid-padded',
        releaseGroupMbid: 'rg-padded', isrc: 'USRC17607839', year: null, duration: null,
      },
      {
        artist: 'Nova', title: 'Numbers', album: null, filepath: 'm/Numbers.mp3', recordingMbid: undefined,
        releaseGroupMbid: null, isrc: null, year: 1999, duration: 61.5,
      },
    ]);
    for (const r of out.results) {
      assert.equal(recommendationSchema.validate(r).error, undefined, r.title);
    }

    // A padded MBID is that MBID: the library's copy keeps the song out,
    // and two peers' copies are one song (the cross-peer `m:` key; the
    // titles differ, so only the MBID can tell).
    const excludeSets = { ...none(), mbids: new Set(['mbid-owned']) };
    const two = mergePeerAnswers([peerRow(1, 'A'), peerRow(2, 'B')], [
      ok([song('Owned', 0.95, { recordingMbid: `${pad}mbid-owned` }), song('Shared Here', 0.9, { recordingMbid: `${pad}mbid-shared${pad}` })]),
      ok([song('Shared There', 0.85, { artist: 'Elsewhere', recordingMbid: 'mbid-shared' })]),
    ], { excludeSets, limit: 10 });
    assert.deepEqual(two.results.map((r) => [r.title, r.peer.id, r.recordingMbid]), [['Shared Here', 1, 'mbid-shared']]);
  });

  test('only the rows a peer was asked for are looked at: its first PEER_LIMIT_CAP (100), in its own order', () => {
    // 5,000 well-formed novel rows, the BEST of them after the 100th: a
    // merge that looked further would rank those first, and fill a
    // per-peer limit of 200.
    const rows = Array.from({ length: 5000 }, (_v, i) => song(`Row ${i}`, i < 100 ? 0.5 - i / 1000 : 0.9));
    const out = mergePeerAnswers([peerRow(1, 'A')], [ok(rows)], { excludeSets: none(), limit: 200 });
    assert.equal(out.results.length, 100);
    assert.deepEqual(out.results.map((r) => r.title), rows.slice(0, 100).map((r) => r.title));
    assert.equal(out.peers[0].results.length, 100);
  });

  test('a dropped row never claims its song: another peer\'s copy still shows', () => {
    const peers = [peerRow(1, 'A'), peerRow(2, 'B')];
    const out = mergePeerAnswers(peers, [
      ok([song('Shared', 0.9, { filepath: `m/${'p'.repeat(3000)}.mp3` })]),
      ok([song('Shared', 0.7)]),
    ], { excludeSets: none(), limit: 10 });
    assert.deepEqual(out.results.map((r) => [r.title, r.peer.id]), [['Shared', 2]]);
    assert.deepEqual(out.peers.map((g) => g.results.length), [0, 1]);
  });
});
