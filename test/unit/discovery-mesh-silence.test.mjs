/**
 * The mesh-health watch's silence belt (discovery-seeds.silenceVerdict) and
 * the neighbor-set reset event (discovery-p2p 'neighbors').
 *
 * WHY. On 2026-10-22 the production sidecar's gossip actor wedged (the
 * iroh-gossip 0.101 blocking send): the sidecar kept answering `status`
 * with joined=true, neighbors=4 for 22 hours while nothing arrived, and the
 * watch — which only re-joins on neighbors == 0 — saw nothing wrong. A
 * sidecar ≥ v1.4.0 reports lastGossipAgeSecs; the verdict turns "connected
 * but silent" into a restart, with two deliberate non-triggers:
 *
 *  - a node whose only neighbors are community seeds hears nothing by
 *    design (seeds relay, never announce);
 *  - a node with nobody recent in its catalog has nobody to hear.
 *
 * Pure function, so no sidecar, no network, no server.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { silenceVerdict } from '../../src/state/discovery-seeds.js';
import { events, getNeighborIds } from '../../src/state/discovery-p2p.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);
const PEER = 'c'.repeat(64);
const recent = [NOW - 60 * 60 * 1000];          // a catalog peer heard an hour ago
const stale = [NOW - 3 * 24 * 60 * 60 * 1000];  // three days ago — nobody to hear

const silent = (extra = {}) => ({ joined: true, neighbors: 2, lastGossipAgeSecs: 30 * 60, ...extra });

describe('silenceVerdict: connected-but-silent is a dead mesh', () => {
  test('healthy mesh (recent gossip) is never judged', () => {
    assert.equal(silenceVerdict({ status: silent({ lastGossipAgeSecs: 12 }), neighborIds: [PEER], catalogHeardAt: recent, now: NOW }), null);
  });

  test('silent with a real neighbor and a recent witness → restart reason', () => {
    const why = silenceVerdict({ status: silent(), neighborIds: [PEER, SEED_A], seedIds: [SEED_A, SEED_B], catalogHeardAt: recent, now: NOW });
    assert.match(why, /joined with 2 neighbor\(s\) but nothing heard for 1800s/);
  });

  test('neighbor ids unknown (empty) still judges on the sidecar count', () => {
    assert.ok(silenceVerdict({ status: silent(), neighborIds: [], seedIds: [SEED_A], catalogHeardAt: recent, now: NOW }));
  });

  test('only seeds as neighbors: silence is by design', () => {
    assert.equal(silenceVerdict({ status: silent(), neighborIds: [SEED_A, SEED_B], seedIds: [SEED_A, SEED_B], catalogHeardAt: recent, now: NOW }), null);
  });

  test('no recent catalog witness: nobody to hear, never restart-loop a lone server', () => {
    assert.equal(silenceVerdict({ status: silent(), neighborIds: [PEER], catalogHeardAt: stale, now: NOW }), null);
    assert.equal(silenceVerdict({ status: silent(), neighborIds: [PEER], catalogHeardAt: [], now: NOW }), null);
    assert.equal(silenceVerdict({ status: silent(), neighborIds: [PEER], catalogHeardAt: [NaN], now: NOW }), null);
  });

  test('older sidecars (no lastGossipAgeSecs) and null ages are never judged', () => {
    assert.equal(silenceVerdict({ status: { joined: true, neighbors: 3 }, neighborIds: [PEER], catalogHeardAt: recent, now: NOW }), null);
    assert.equal(silenceVerdict({ status: silent({ lastGossipAgeSecs: null }), neighborIds: [PEER], catalogHeardAt: recent, now: NOW }), null);
  });

  test('not joined, or zero neighbors, belongs to the re-join path, not the belt', () => {
    assert.equal(silenceVerdict({ status: silent({ joined: false }), neighborIds: [PEER], catalogHeardAt: recent, now: NOW }), null);
    assert.equal(silenceVerdict({ status: silent({ neighbors: 0 }), neighborIds: [PEER], catalogHeardAt: recent, now: NOW }), null);
    assert.equal(silenceVerdict({ status: null }), null);
  });
});

describe("discovery-p2p 'neighbors' reset event", () => {
  test('a reset clears the tracked ids; anything else is ignored', () => {
    events.emit('neighbor', { up: true, id: PEER });
    events.emit('neighbor', { up: true, id: SEED_A });
    assert.deepEqual(new Set(getNeighborIds()), new Set([PEER, SEED_A]));
    events.emit('neighbors', { reset: false });
    events.emit('neighbors', {});
    assert.equal(getNeighborIds().length, 2);
    events.emit('neighbors', { reset: true });
    assert.deepEqual(getNeighborIds(), []);
    // The replay after a reset rebuilds the set from scratch.
    events.emit('neighbor', { up: true, id: PEER });
    assert.deepEqual(getNeighborIds(), [PEER]);
    events.emit('neighbor', { up: false, id: PEER });
    assert.deepEqual(getNeighborIds(), []);
  });
});
