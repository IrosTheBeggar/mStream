/**
 * Unit tests for the pure shelf-rotation policy
 * (src/state/discovery-peer-rotation.js). No server, no sidecar, no config
 * singleton — every decision input is handcrafted, so each rule is pinned
 * down in isolation:
 *
 *   - gates: rotation is an auto-fetch behavior (feature off / count 0 /
 *     rotationDays 0 all disable it)
 *   - eligibility: membership age via firstFetchedAt; pinned = immune
 *   - swap-only: no candidate -> no eviction, ever
 *   - eviction order: offline (longest-silent) -> oldest membership ->
 *     prefer entries other seeders still hold
 *   - candidate order: never-held first (ledger), then the shared
 *     usefulness order (model-compatible -> online -> biggest)
 *   - candidate fetchability: offline origins with no live seeders are not
 *     candidates at all — novelty never outranks reachability
 *   - capacity: the incoming snapshot must fit AFTER the eviction;
 *     evictFirst signals when it only fits because of it
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRotation,
  candidateOrder,
  rotationCandidateOrder,
  ONLINE_WINDOW_MS,
} from '../../src/state/discovery-peer-rotation.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const id = (ch) => ch.repeat(64);

// A held shelf entry, aged `heldDays` and heard-from per `updatedAt` on the
// catalog side (see cat()).
function held(ch, { heldDays = 10, pinned = false, sizeBytes = 1000 } = {}) {
  return {
    endpointId: id(ch),
    hash: id(ch === 'a' ? 'f' : ch), // hash distinct from endpointId is fine
    sizeBytes,
    pinned,
    firstFetchedAt: iso(heldDays * DAY),
    fetchedAt: iso(1 * DAY),
  };
}

// A catalog entry. `silentMs` controls online-ness (ONLINE_WINDOW_MS = 90s).
function cat(ch, { silentMs = 0, size = 1000, rowCount = 10, modelId = 'model-x' } = {}) {
  return {
    from: id(ch),
    updatedAt: iso(silentMs),
    payload: { size, rowCount, modelId, hash: id(ch) },
  };
}

// Baseline inputs: one aged unpinned entry, one fresh candidate, ample cap.
function inputs(overrides = {}) {
  return {
    shelf: [held('a')],
    catalog: [cat('c')],
    ledger: {},
    localModel: null,
    now: NOW,
    rotationDays: 7,
    autoFetch: true,
    autoFetchCount: 3,
    capBytes: 100000,
    ...overrides,
  };
}

describe('planRotation — gates', () => {
  test('happy path: aged entry + candidate -> swap plan', () => {
    const plan = planRotation(inputs());
    assert.deepEqual(plan, { evictId: id('a'), fetchId: id('c'), evictFirst: false });
  });

  test('rotationDays 0 disables rotation', () => {
    assert.equal(planRotation(inputs({ rotationDays: 0 })), null);
  });

  test('autoFetch off disables rotation', () => {
    assert.equal(planRotation(inputs({ autoFetch: false })), null);
  });

  test('autoFetchCount 0 (paused shelf) disables rotation', () => {
    assert.equal(planRotation(inputs({ autoFetchCount: 0 })), null);
  });
});

describe('planRotation — eligibility', () => {
  test('an entry younger than rotationDays is not eligible', () => {
    assert.equal(planRotation(inputs({ shelf: [held('a', { heldDays: 3 })] })), null);
  });

  test('a refresh must not reset the clock: age comes from firstFetchedAt, not fetchedAt', () => {
    // fetchedAt is 1 day ago (a recent refresh) but membership is 10 days old.
    const plan = planRotation(inputs());
    assert.ok(plan, 'the recently-refreshed but long-held entry must still rotate');
  });

  test('pinned entries are immune however old', () => {
    assert.equal(planRotation(inputs({ shelf: [held('a', { heldDays: 400, pinned: true })] })), null);
  });

  test('a missing membership timestamp is treated as ancient (eligible)', () => {
    const e = held('a');
    delete e.firstFetchedAt;
    delete e.fetchedAt;
    assert.ok(planRotation(inputs({ shelf: [e] })));
  });
});

describe('planRotation — swap-only', () => {
  test('no candidates at all -> no eviction', () => {
    assert.equal(planRotation(inputs({ catalog: [] })), null);
  });

  test('candidates already held, blocked, or in backoff do not count', () => {
    const base = inputs({
      shelf: [held('a'), held('b', { heldDays: 1 })],
      catalog: [cat('a'), cat('x'), cat('y')],
      isBlocked: (p) => p === id('x'),
      inBackoff: (p) => p === id('y'),
    });
    assert.equal(planRotation(base), null);
  });
});

describe('planRotation — eviction order', () => {
  test('an offline peer is evicted before an online one', () => {
    const plan = planRotation(inputs({
      shelf: [held('a'), held('b')],
      // a is online (heard 5s ago), b has been silent for a day.
      catalog: [cat('a', { silentMs: 5000 }), cat('b', { silentMs: DAY }), cat('c')],
    }));
    assert.equal(plan.evictId, id('b'));
  });

  test('among offline peers, the longest-silent goes first', () => {
    const plan = planRotation(inputs({
      shelf: [held('a'), held('b')],
      catalog: [cat('a', { silentMs: 2 * DAY }), cat('b', { silentMs: 1 * DAY }), cat('c')],
    }));
    assert.equal(plan.evictId, id('a'));
  });

  test('a held peer with NO catalog entry sorts as silent-forever (first out)', () => {
    const plan = planRotation(inputs({
      shelf: [held('a'), held('b')],
      catalog: [cat('b', { silentMs: 30 * DAY }), cat('c')], // nothing for a
    }));
    assert.equal(plan.evictId, id('a'));
  });

  test('equal silence: oldest membership goes first', () => {
    const plan = planRotation(inputs({
      shelf: [held('a', { heldDays: 8 }), held('b', { heldDays: 30 })],
      catalog: [cat('c')],
    }));
    assert.equal(plan.evictId, id('b'));
  });

  test('full tie: prefer evicting the snapshot other seeders still hold', () => {
    const a = held('a');
    const b = held('b');
    const plan = planRotation(inputs({
      shelf: [a, b],
      catalog: [cat('c')],
      seederCountOf: (hash) => (hash === b.hash ? 3 : 1),
    }));
    assert.equal(plan.evictId, id('b'), 'the swarm keeps a copy of b; ours was the last copy of a');
  });

  test('pinned entries never win eviction even when they sort worst', () => {
    const plan = planRotation(inputs({
      shelf: [held('a', { heldDays: 400, pinned: true }), held('b', { heldDays: 8 })],
      catalog: [cat('c')],
    }));
    assert.equal(plan.evictId, id('b'));
  });
});

describe('planRotation — candidate choice', () => {
  test('a never-held candidate beats a past evictee', () => {
    const plan = planRotation(inputs({
      catalog: [cat('d'), cat('e')],
      ledger: { [id('d')]: iso(2 * DAY) }, // d was rotated out recently
    }));
    assert.equal(plan.fetchId, id('e'));
  });

  test('among past evictees, the longest-gone returns first', () => {
    const plan = planRotation(inputs({
      catalog: [cat('d'), cat('e')],
      ledger: { [id('d')]: iso(1 * DAY), [id('e')]: iso(30 * DAY) },
    }));
    assert.equal(plan.fetchId, id('e'));
  });

  test('novelty ties fall through to the usefulness order (model-compatible first)', () => {
    const plan = planRotation(inputs({
      localModel: 'model-x',
      catalog: [
        cat('d', { modelId: 'other-model', rowCount: 99999 }),
        cat('e', { modelId: 'model-x', rowCount: 1 }),
      ],
    }));
    assert.equal(plan.fetchId, id('e'));
  });
});

describe('planRotation — candidate fetchability', () => {
  test('an offline candidate with no live seeders is not a candidate', () => {
    assert.equal(planRotation(inputs({
      catalog: [cat('d', { silentMs: DAY })],
    })), null, 'a guaranteed-dead dial must not be planned');
  });

  test('an offline candidate WITH live seeders is fetchable via the swarm', () => {
    const plan = planRotation(inputs({
      catalog: [cat('d', { silentMs: DAY })],
      seederCountOf: (hash) => (hash === id('d') ? 2 : 0),
    }));
    assert.equal(plan.fetchId, id('d'),
      'live holders make an offline origin a perfectly good pick');
  });

  test('the production pathology: only dead candidates -> no plan, no hourly churn', () => {
    // Two long-offline peers, no seeders — the exact shape that produced a
    // guaranteed-failure dial (and a warn line) every hour for two weeks.
    assert.equal(planRotation(inputs({
      catalog: [cat('d', { silentMs: 7 * DAY }), cat('e', { silentMs: 30 * DAY })],
    })), null);
  });

  test('novelty no longer outranks reachability: a dead never-held loses to a live past-evictee', () => {
    const plan = planRotation(inputs({
      catalog: [cat('d', { silentMs: DAY }), cat('e')], // d never held but dead; e alive
      ledger: { [id('e')]: iso(2 * DAY) },              // e was rotated out recently
    }));
    assert.equal(plan.fetchId, id('e'));
  });
});

describe('planRotation — capacity', () => {
  test('the incoming snapshot must fit after the eviction; too big -> next candidate', () => {
    const plan = planRotation(inputs({
      shelf: [held('a', { sizeBytes: 500 })],
      capBytes: 1000,
      catalog: [
        cat('d', { size: 2000, rowCount: 99999 }), // never fits, even post-evict
        cat('e', { size: 800, rowCount: 1 }),      // fits only after the evict
      ],
    }));
    assert.deepEqual(plan, { evictId: id('a'), fetchId: id('e'), evictFirst: true });
  });

  test('no candidate fits even after eviction -> no swap', () => {
    assert.equal(planRotation(inputs({
      shelf: [held('a', { sizeBytes: 100 })],
      capBytes: 1000,
      catalog: [cat('d', { size: 5000 })],
    })), null);
  });

  test('evictFirst is false when the candidate fits in current headroom', () => {
    const plan = planRotation(inputs({
      shelf: [held('a', { sizeBytes: 100 })],
      capBytes: 10000,
      catalog: [cat('d', { size: 500 })],
    }));
    assert.equal(plan.evictFirst, false);
  });
});

describe('order helpers', () => {
  test('candidateOrder: compatible > online > rowCount', () => {
    const list = [
      cat('a', { modelId: 'other', rowCount: 500, silentMs: 0 }),
      cat('b', { modelId: 'model-x', rowCount: 10, silentMs: 10 * DAY }),
      cat('c', { modelId: 'model-x', rowCount: 5, silentMs: 0 }),
      cat('d', { modelId: 'model-x', rowCount: 50, silentMs: 0 }),
    ].sort(candidateOrder('model-x', NOW));
    assert.deepEqual(list.map((c) => c.from[0]), ['d', 'c', 'b', 'a']);
  });

  test('candidateOrder without a local model ignores compatibility', () => {
    const list = [
      cat('a', { modelId: 'other', rowCount: 500 }),
      cat('b', { modelId: 'model-x', rowCount: 10 }),
    ].sort(candidateOrder(null, NOW));
    assert.equal(list[0].from, id('a'));
  });

  test('rotationCandidateOrder: never-held first, then oldest-evicted', () => {
    const ledger = { [id('a')]: iso(1 * DAY), [id('b')]: iso(9 * DAY) };
    const list = [cat('a', { rowCount: 999 }), cat('b'), cat('c', { rowCount: 1 })]
      .sort(rotationCandidateOrder(ledger, null, NOW));
    assert.deepEqual(list.map((c) => c.from[0]), ['c', 'b', 'a']);
  });

  test('the online window matches the announce cadence', () => {
    assert.equal(ONLINE_WINDOW_MS, 90 * 1000);
  });
});
