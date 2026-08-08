import { test } from 'node:test';
import assert from 'node:assert/strict';

// The reboot race that silently killed discovery-p2p.
//
// A soft reboot stops the stack and re-serves. Stopping the sidecar can take
// ~10s (shutdown-RPC grace + SIGKILL fallback), while server.js bounds its wait
// at 5s — so the restart routinely lands while the stop is still draining. The
// stack must serialize that: a start arriving mid-stop has to WAIT, not return
// early on a flag the stop hasn't cleared yet.
//
// These model the guard logic directly. The real module dynamically imports the
// whole p2p world (sidecar spawn included), which a unit test cannot stand up —
// so the contract under test is the flag/promise ordering, which is precisely
// what was wrong. makeLegacyStack is the negative control: it reproduces the
// previous implementation and must FAIL the contract the fixed one upholds.

// Current implementation: `running` states intent and clears up front, and a
// start serializes behind the in-flight stop.
function makeFixedStack({ stopMs }) {
  let running = false;
  let stopping = null;
  let sidecars = 0;

  async function start() {
    if (stopping) { try { await stopping; } catch (_err) { /* ignore */ } }
    if (running) { return; }
    running = true;
    sidecars += 1;
  }

  async function stop() {
    if (stopping) { return stopping; }
    running = false;                 // intent, before the first await
    stopping = (async () => {
      await new Promise((r) => setTimeout(r, stopMs));
      sidecars -= 1;                 // the late teardown lands here
    })();
    try { await stopping; } finally { stopping = null; }
  }

  return { start, stop, state: () => ({ running, sidecars }) };
}

// The PREVIOUS implementation, verbatim in shape: no `stopping` promise at all,
// and `running` cleared only after the teardown finished. Nothing here may be
// borrowed from the fixed version — a control that shares the fix proves
// nothing (a first attempt at this test did exactly that and passed).
function makeLegacyStack({ stopMs }) {
  let running = false;
  let sidecars = 0;

  async function start() {
    if (running) { return; }         // stale `true` during a stop => silent no-op
    running = true;
    sidecars += 1;
  }

  async function stop() {
    await new Promise((r) => setTimeout(r, stopMs));
    sidecars -= 1;
    running = false;                 // cleared far too late
  }

  return { start, stop, state: () => ({ running, sidecars }) };
}

// server.js: stop is awaited, but only up to a 5s bound (scaled down here).
function rebootWithTimeout(stack, budgetMs) {
  return Promise.race([
    stack.stop().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
}

test('a stop that outlasts the reboot budget still ends with the stack running', async () => {
  const stack = makeFixedStack({ stopMs: 100 });
  await stack.start();
  assert.deepEqual(stack.state(), { running: true, sidecars: 1 });

  await rebootWithTimeout(stack, 50);   // budget expires first, as in production
  await stack.start();                  // the re-served instance starts the stack
  await new Promise((r) => setTimeout(r, 150));  // let the late teardown land

  assert.deepEqual(stack.state(), { running: true, sidecars: 1 },
    'after a reboot the stack must be running with exactly one sidecar');
});

test('NEGATIVE CONTROL: clearing the flag only after stop reproduces the silent death', async () => {
  const stack = makeLegacyStack({ stopMs: 100 });
  await stack.start();

  await rebootWithTimeout(stack, 50);
  await stack.start();
  await new Promise((r) => setTimeout(r, 150));

  const { running, sidecars } = stack.state();
  assert.equal(running, false, 'old logic: the late stop clears the flag after the restart');
  assert.equal(sidecars, 0,
    'old logic: the restart no-oped on the stale flag and the late stop killed the sidecar');
});

test('concurrent stops coalesce instead of tearing down twice', async () => {
  const stack = makeFixedStack({ stopMs: 50 });
  await stack.start();
  await Promise.all([stack.stop(), stack.stop(), stack.stop()]);
  assert.deepEqual(stack.state(), { running: false, sidecars: 0 });
});

test('a start during an in-flight stop waits for it rather than no-oping', async () => {
  const stack = makeFixedStack({ stopMs: 60 });
  await stack.start();
  const stopping = stack.stop();
  await stack.start();     // must block until the stop finished, then restart
  assert.deepEqual(stack.state(), { running: true, sidecars: 1 });
  await stopping;
});
