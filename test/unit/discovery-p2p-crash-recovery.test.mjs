import { test } from 'node:test';
import assert from 'node:assert/strict';

// The silent outage: a sidecar that died on its own and never came back.
//
// The sidecar is a child process — an OOM kill takes it down with nobody
// asking. p2p.start() had exactly ONE real caller (the stack's boot), and the
// two periodic passes that could have noticed (the mesh-health watch, the
// catalog prune) both returned early on `!isRunning()`. So the process stayed
// dead, the config kept saying "enabled", and the only trace was a single
// warn line at the moment of death.
//
// There was a second, nastier half. publish/fetch/announce all lazily
// start() the sidecar, so unrelated background work — an hourly rotation
// fetch — would respawn the PROCESS without rejoining the TOPIC. That state
// reports `running: true` while being just as invisible as no process at
// all, and the health watch skipped it too (`if (!s.joined ...) return`).
// Hence the contract below is about `joined`, not `running`: recovery must
// replay the whole start sequence, because the topic subscription, the
// announce payload and the holds beacon all live in the sidecar's memory.
//
// These model the flag/timer logic directly. The real module dynamically
// imports the entire p2p world (sidecar spawn included), which a unit test
// cannot stand up — the same reason discovery-p2p-stack-race.test.mjs models
// its contract — and the end-to-end proof against a real binary lives in
// test/integration/discovery-p2p-crash-recovery.test.mjs. makeLegacyStack is
// the negative control: it reproduces the previous implementation and must
// FAIL every contract the fixed one upholds.

const RECOVERY_DELAYS_MS = [5, 15, 60, 300]; // shape of the real ladder, scaled down

// Current implementation: the child's death is reported to the stack, which
// replays the whole start; `running` is intent, and a start that finds the
// sidecar gone treats itself as the repair.
function makeFixedStack({ spawnFails = 0 } = {}) {
  let running = false;
  let sidecarAlive = false;
  let joined = false;
  // The operator's own flag (config.program.discoveryP2p.enabled). Recovery
  // reads it as the veto of last resort: `running` can be restored by the
  // re-arm path, the config cannot. disable() mirrors the admin route's
  // order — flag first, stack stop second (src/api/admin.js).
  let configEnabled = true;
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  let failuresLeft = spawnFails;
  // Bumped by stop(); a start attempt in flight across a stop must fail,
  // exactly as the real spawn does when the teardown kills its child.
  let stopGen = 0;
  let pendingGate = null;
  const delaysUsed = [];
  let starts = 0;

  function cancelRecovery() {
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
    recoveryAttempts = 0;
  }

  async function start() {
    if (running) {
      if (sidecarAlive) { return; }   // genuinely up: nothing to do
      running = false;                // stale flag — this call IS the repair
    }
    starts += 1;
    const gen = stopGen;
    // A one-shot gate a test can arm to park an attempt mid-start — the
    // deterministic stand-in for "spawn + join take real time".
    if (pendingGate) { const g = pendingGate; pendingGate = null; await g.promise; }
    if (gen !== stopGen) { throw new Error('torn down mid-start'); }
    if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('spawn failed'); }
    sidecarAlive = true;
    joined = true;                    // the full sequence: spawn AND join
    running = true;
    cancelRecovery();
  }

  async function stop() {
    stopGen += 1;
    running = false;
    cancelRecovery();
    sidecarAlive = false;
    joined = false;
  }

  // The admin disable route, in its real order: the config flag is written
  // (and live in config.program) BEFORE the stack stop begins — what makes
  // the recovery gate race-free.
  async function disable() {
    configEnabled = false;
    await stop();
  }

  // What discovery-p2p.js calls when the child died without us asking.
  function onUnexpectedExit() {
    sidecarAlive = false;
    joined = false;
    scheduleRecovery();
  }

  function scheduleRecovery() {
    if (!running || recoveryTimer) { return; }
    const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempts, RECOVERY_DELAYS_MS.length - 1)];
    delaysUsed.push(delay);
    recoveryAttempts += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!running || !configEnabled) { return; }
      running = false;
      start().catch(() => {
        // Disabled while the attempt was in flight: the failure IS the
        // teardown winning. Stand down instead of re-arming.
        if (!configEnabled) { return; }
        running = true;
        scheduleRecovery();
      });
    }, delay);
    // The real timer is unref'd too; without it a stack still walking its
    // ladder would hold the test runner's event loop open.
    if (recoveryTimer.unref) { recoveryTimer.unref(); }
  }

  // A lazy start(), as publish/fetch/announce perform it: the process comes
  // back, the topic subscription does NOT.
  function lazyStartSidecarOnly() { sidecarAlive = true; }

  return {
    start, stop, disable, onUnexpectedExit, lazyStartSidecarOnly,
    // Arm the NEXT n respawns to fail, so a test can drive the ladder. Has
    // to reach the closure's own start(); a monkeypatched .start property
    // would never be seen by scheduleRecovery.
    failNext: (n) => { failuresLeft = n; },
    // Park the NEXT start attempt until the returned release() is called —
    // how a test holds a recovery attempt "in flight" without racing timers.
    gateNextStart: () => {
      let release;
      const promise = new Promise((r) => { release = r; });
      pendingGate = { promise };
      return release;
    },
    state: () => ({ running, sidecarAlive, joined, starts, configEnabled }),
    delaysUsed: () => [...delaysUsed],
  };
}

// The PREVIOUS implementation, verbatim in shape: no death notification at
// all, and a start that returns early on the stale flag. Nothing here may be
// borrowed from the fixed version.
function makeLegacyStack() {
  let running = false;
  let sidecarAlive = false;
  let joined = false;
  let starts = 0;

  async function start() {
    if (running) { return; }          // stale `true` after a crash => no-op
    starts += 1;
    sidecarAlive = true;
    joined = true;
    running = true;
  }
  async function stop() { running = false; sidecarAlive = false; joined = false; }
  function onUnexpectedExit() { sidecarAlive = false; joined = false; }  // nobody listening
  function lazyStartSidecarOnly() { sidecarAlive = true; }

  return {
    start, stop, onUnexpectedExit, lazyStartSidecarOnly,
    state: () => ({ running, sidecarAlive, joined, starts }),
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('a crashed sidecar is brought back AND put on the topic again', async () => {
  const stack = makeFixedStack();
  await stack.start();
  assert.deepEqual(stack.state(), { running: true, sidecarAlive: true, joined: true, starts: 1, configEnabled: true });

  stack.onUnexpectedExit();                       // the OOM kill
  assert.equal(stack.state().sidecarAlive, false);

  await settle(40);                               // first rung is 5ms here
  const s = stack.state();
  assert.equal(s.sidecarAlive, true, 'the sidecar must be respawned');
  assert.equal(s.joined, true, 'and rejoined — a bare respawn is not recovery');
});

test('NEGATIVE CONTROL: with no death hook the crash is permanent', async () => {
  const stack = makeLegacyStack();
  await stack.start();

  stack.onUnexpectedExit();
  await settle(40);

  const s = stack.state();
  assert.equal(s.sidecarAlive, false, 'old logic: nothing ever respawned it');
  assert.equal(s.running, true, 'old logic: the config-level flag still claims enabled');
});

test('a lazy start (rotation fetch) leaves it un-joined — recovery must not be satisfied by that', async () => {
  const stack = makeLegacyStack();
  await stack.start();
  stack.onUnexpectedExit();
  stack.lazyStartSidecarOnly();       // what an hourly rotation fetch did

  const s = stack.state();
  assert.equal(s.sidecarAlive, true, 'the process is back...');
  assert.equal(s.joined, false, '...but off the topic: running:true, invisible to the network');
});

test('re-enabling after a crash repairs the stack instead of no-oping on the stale flag', async () => {
  const stack = makeFixedStack();
  await stack.start();
  stack.onUnexpectedExit();

  await stack.start();                // the admin enable route
  const s = stack.state();
  assert.equal(s.sidecarAlive, true, 'the operator asked for the network; they must get it');
  assert.equal(s.joined, true);
  assert.equal(s.starts, 2, 'a real second start, not an early return');
});

test('NEGATIVE CONTROL: the old guard answered success and did nothing', async () => {
  const stack = makeLegacyStack();
  await stack.start();
  stack.onUnexpectedExit();

  await stack.start();                // returns without error — and without effect
  const s = stack.state();
  assert.equal(s.sidecarAlive, false, 'old logic: silent no-op behind a 200');
  assert.equal(s.starts, 1, 'old logic: the second start never ran');
});

test('a deliberate stop cancels recovery — a disabled feature stays disabled', async () => {
  const stack = makeFixedStack();
  await stack.start();

  stack.onUnexpectedExit();           // crash lands...
  await stack.stop();                 // ...just before the operator disables it
  await settle(40);

  assert.deepEqual(stack.state(), { running: false, sidecarAlive: false, joined: false, starts: 1, configEnabled: true },
    'recovery must not resurrect a sidecar the operator just turned off');
});

test('a sidecar that keeps dying widens the backoff instead of hot-looping', async () => {
  const stack = makeFixedStack();
  await stack.start();
  stack.failNext(3);                  // the next three respawns fail
  stack.onUnexpectedExit();
  await settle(600);                  // 5 + 15 + 60 + 300 (the rung that works)

  const used = stack.delaysUsed();
  assert.ok(used.length >= 3, `expected the ladder to be walked, saw ${used.join(',') || 'nothing'}`);
  for (let i = 1; i < used.length; i++) {
    assert.ok(used[i] >= used[i - 1], `backoff must never shrink: ${used.join(',')}`);
  }
  assert.ok(used.at(-1) <= RECOVERY_DELAYS_MS.at(-1), 'and must cap at the ceiling');
  assert.equal(stack.state().joined, true, 'and it must still get back on the topic in the end');
});

test('a recovery that keeps failing never gives up', async () => {
  // The failure being fixed is a server silently off the network forever, so
  // a recovery loop that exhausts itself would just reintroduce it.
  const stack = makeFixedStack();
  await stack.start();
  stack.failNext(99);
  stack.onUnexpectedExit();
  await settle(300);

  assert.ok(stack.delaysUsed().length >= 3, 'must keep retrying');
  assert.equal(stack.state().sidecarAlive, false, 'still down — but still trying');
});

// The in-flight flavor of the disable race. The "deliberate stop" test above
// covers a stop that lands BEFORE the timer fires (cancelRecovery catches
// it); this one lands AFTER — the attempt is already mid-start, so there is
// no timer to cancel, the attempt fails against the teardown, and only the
// config gate in the re-arm path stands between the operator and a
// resurrected sidecar.
test('a disable landing while a recovery attempt is in flight must not resurrect the stack', async () => {
  const stack = makeFixedStack();
  await stack.start();
  const release = stack.gateNextStart(); // park the upcoming replay mid-start
  stack.onUnexpectedExit();              // crash → first rung arms (5ms)
  await settle(40);                      // rung fired; the attempt is now held in flight
  assert.equal(stack.state().starts, 2, 'the replay attempt must be in flight before the disable');

  await stack.disable();                 // operator turns it off: config first, then the stack stop
  release();                             // teardown wins; the parked attempt now fails
  await settle(400);                     // long enough for every rung to fire, had one re-armed

  const s = stack.state();
  assert.equal(s.sidecarAlive, false, 'recovery must never outvote the operator');
  assert.equal(s.running, false, 'and must not restore the intent flag of a disabled feature');
});

// The same choreography against the UNGATED re-arm — the shape that shipped
// in the original recovery patch (restore `running`, re-schedule,
// unconditionally). Reproduced here as its own model, borrowing nothing from
// the fixed one, and it must FAIL the contract: config off, stack back on.
function makeUngatedRecoveryStack() {
  let running = false;
  let sidecarAlive = false;
  let joined = false;
  let configEnabled = true;
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  let stopGen = 0;
  let pendingGate = null;
  let starts = 0;

  async function start() {
    if (running) {
      if (sidecarAlive) { return; }
      running = false;
    }
    starts += 1;
    const gen = stopGen;
    if (pendingGate) { const g = pendingGate; pendingGate = null; await g.promise; }
    if (gen !== stopGen) { throw new Error('torn down mid-start'); }
    sidecarAlive = true;
    joined = true;
    running = true;
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
    recoveryAttempts = 0;
  }

  async function stop() {
    stopGen += 1;
    running = false;
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
    recoveryAttempts = 0;
    sidecarAlive = false;
    joined = false;
  }

  async function disable() { configEnabled = false; await stop(); }

  function onUnexpectedExit() { sidecarAlive = false; joined = false; scheduleRecovery(); }

  function scheduleRecovery() {
    if (!running || recoveryTimer) { return; }
    const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempts, RECOVERY_DELAYS_MS.length - 1)];
    recoveryAttempts += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!running) { return; }              // no config veto here — the gap under test
      running = false;
      start().catch(() => { running = true; scheduleRecovery(); });
    }, delay);
    if (recoveryTimer.unref) { recoveryTimer.unref(); }
  }

  return {
    start, disable, onUnexpectedExit,
    gateNextStart: () => {
      let release;
      const promise = new Promise((r) => { release = r; });
      pendingGate = { promise };
      return release;
    },
    state: () => ({ running, sidecarAlive, joined, starts, configEnabled }),
  };
}

test('NEGATIVE CONTROL: an ungated re-arm resurrects a stack the operator disabled', async () => {
  const stack = makeUngatedRecoveryStack();
  await stack.start();
  const release = stack.gateNextStart();
  stack.onUnexpectedExit();
  await settle(40);
  assert.equal(stack.state().starts, 2, 'the replay attempt must be in flight before the disable');

  await stack.disable();
  release();
  await settle(400);

  const s = stack.state();
  assert.equal(s.sidecarAlive, true,
    'ungated: the failed attempt re-armed and the next rung brought it back — config off, stack on');
  assert.equal(s.configEnabled, false, 'while the operator-facing flag still says disabled');
});
