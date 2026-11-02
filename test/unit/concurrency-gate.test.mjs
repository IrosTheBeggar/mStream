/**
 * The in-process concurrency gate (src/util/concurrency-gate.js) behind the
 * flow route's one-solve-at-a-time rule: immediate grants while a slot is
 * free, a FIFO queue capped by count, a 429 past it, idempotent releases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyGate } from '../../src/util/concurrency-gate.js';

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('one holder, four waiters in FIFO order, a 429 past that, no over-free', async () => {
  const gate = createConcurrencyGate({ maxActive: 1, maxWaiting: 4, busyMessage: 'busy' });

  const first = await gate.acquire();
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 0);

  const granted = [];
  const waits = [0, 1, 2, 3].map((k) => gate.acquire().then((release) => { granted.push({ k, release }); }));
  assert.equal(gate.waiting, 4);

  await assert.rejects(gate.acquire(), (err) => err.status === 429 && err.message === 'busy');
  assert.equal(gate.waiting, 4, 'a refused caller is not queued');

  await flush();
  assert.equal(granted.length, 0, 'nobody is granted while the slot is held');

  first();
  await flush();
  assert.deepEqual(granted.map((g) => g.k), [0]);
  assert.equal(gate.active, 1, 'the slot is handed over, not freed');
  assert.equal(gate.waiting, 3);

  first();   // a double release must not free the slot waiter 0 now holds
  await flush();
  assert.deepEqual(granted.map((g) => g.k), [0]);
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 3);

  for (let k = 0; k < 4; k++) {
    granted[k].release();
    await flush();
  }
  await Promise.all(waits);
  assert.deepEqual(granted.map((g) => g.k), [0, 1, 2, 3]);
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting, 0);

  const again = await gate.acquire();
  assert.equal(gate.active, 1, 'free again: the next acquire is immediate');
  again();
  assert.equal(gate.active, 0);
});
