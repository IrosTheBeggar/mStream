/**
 * The sidecar memory watchdog, end to end against a real binary.
 *
 * WHY IT EXISTS. The #880 outage's root cause was a sidecar whose RSS
 * climbed ~2-3MB/h (a connection leak in iroh-gossip) until, at ~102 hours
 * of uptime, it out-grew the entire Node server and the container's OOM
 * killer SIGKILLed it. The leak itself is fixed in sidecar v1.0.2, but the
 * CLASS must never reach an outage again: whatever leaks next — an upstream
 * regression, a different crate — the watchdog converts it into a planned
 * restart with a loud log line, long before the kernel starts choosing
 * victims. It also protects the SERVER: on a host with a big library, Node
 * out-weighs the sidecar and the next OOM kill would take the whole thing.
 *
 * MECHANISM UNDER TEST. The mesh-health watch reads the sidecar's RSS each
 * tick and, over the discoveryP2p.sidecarMaxRssMb ceiling, kills the child
 * WITHOUT bumping the stop generation — so the exit classifies as
 * unexpected and #880's crash recovery replays the whole stack (spawn,
 * join, announce). The suite forces a breach by setting the ceiling to 1MB
 * (any real sidecar is ~20MB), which also means the watchdog keeps firing
 * on every later tick — assertions poll for the up-windows in that cycle
 * rather than assuming a settled end state.
 *
 * Needs a real sidecar binary and a POSIX ps, like the crash-recovery
 * suite; skips in CI where neither exists.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();
const SKIP = process.platform === 'win32'
  ? 'needs a POSIX ps to observe the sidecar grandchild'
  : (SIDECAR_BIN ? false : 'no p2p-sidecar binary on this machine');

function sidecarPids(dataDir) {
  const out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n')
    .filter((line) => line.includes('p2p-sidecar') && line.includes(dataDir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function pollUntil(fn, { timeoutMs = 60000, everyMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe('discovery p2p watchdog: an over-ceiling sidecar is restarted through crash recovery', { skip: SKIP }, () => {
  let server;
  let statusOf;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      // Ceiling of 1MB: every real sidecar breaches on the first watch tick.
      // The 4s tick (vs 5min in production) keeps the whole cycle inside the
      // test budget while leaving a wide-enough up-window between recovery
      // completing (~5.5s after a kill) and the next tick to observe it.
      extraConfig: {
        discoveryP2p: { enabled: true, useCommunitySeeds: false, sidecarMaxRssMb: 1 },
      },
      env: { MSTREAM_TEST_DISCOVERY_HEALTH_MS: '4000' },
    });
    statusOf = async () =>
      (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
  });

  after(async () => { if (server) { await server.stop(); } });

  test('breach → watchdog kill → recovery replays the stack, identity kept', async () => {
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');

    const healthy = await pollUntil(
      async () => { const s = await statusOf(); return s.running && s.joined ? s : null; },
      { what: 'the boot stack to come up' },
    );
    const [bootPid] = sidecarPids(dataDir);
    assert.ok(bootPid, 'a sidecar should be running after boot');

    // The first watch tick (≤4s) reads RSS ≈20MB against the 1MB ceiling and
    // kills the child; the server notices before recovery replays.
    await pollUntil(
      async () => (await statusOf()).running === false,
      { timeoutMs: 15000, what: 'the watchdog to kill the over-ceiling sidecar' },
    );

    // While the sidecar is down, the status route must SAY that recovery
    // owns it — the field the panel renders as "reconnecting, attempt N".
    await pollUntil(async () => {
      const st = await statusOf();
      if (st.running) { return true; } // recovery already won the race — fine
      return st.recovery && (st.recovery.attempts >= 1 || st.recovery.retryPending) ? true : null;
    }, { timeoutMs: 10000, what: 'the status route to report recovery in progress' });

    // Crash recovery must bring back a NEW process, joined, same identity —
    // the whole #880 contract, triggered by the watchdog instead of an OOM.
    const recovered = await pollUntil(async () => {
      const s = await statusOf();
      if (!s.running || !s.joined) { return null; }
      const pids = sidecarPids(dataDir);
      return pids.length === 1 && pids[0] !== bootPid ? { s, pid: pids[0] } : null;
    }, { what: 'recovery to replay the stack with a fresh sidecar' });

    assert.equal(recovered.s.endpointId, healthy.endpointId,
      'a watchdog restart must keep the persisted endpoint identity');

    // The breach is a countable event, not just a log line.
    const st = await statusOf();
    assert.ok(st.watchdog.restarts >= 1,
      `the status route must count watchdog restarts (saw ${st.watchdog.restarts})`);
    assert.equal(st.watchdog.maxRssMb, 1, 'the route echoes the configured ceiling');
  });

  test('the cycle repeats without orphan accumulation', async () => {
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');
    // With the ceiling still at 1MB the kill/recover loop is ongoing. Sample
    // through one more full cycle: never more than one sidecar process, and
    // the server itself stays healthy throughout.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      assert.ok(sidecarPids(dataDir).length <= 1, 'never more than one sidecar, even mid-cycle');
      await new Promise((r) => setTimeout(r, 500));
    }
    const ping = await fetch(`${server.baseUrl}/api/v1/ping`);
    assert.equal(ping.status, 200, 'the music server must ride through watchdog cycles untouched');
  });
});

describe('discovery p2p watchdog: the default ceiling never fires on a healthy sidecar', { skip: SKIP }, () => {
  let server;
  let statusOf;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      // Default sidecarMaxRssMb (256MB) — a ~20MB sidecar sits far under it.
      // A 1s tick packs many watchdog evaluations into the observation window.
      extraConfig: { discoveryP2p: { enabled: true, useCommunitySeeds: false } },
      env: { MSTREAM_TEST_DISCOVERY_HEALTH_MS: '1000' },
    });
    statusOf = async () =>
      (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
  });

  after(async () => { if (server) { await server.stop(); } });

  test('no false positives: pid stable across many watch ticks', async () => {
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');
    await pollUntil(
      async () => { const s = await statusOf(); return s.running && s.joined ? s : null; },
      { what: 'the boot stack to come up' },
    );
    const [pid] = sidecarPids(dataDir);
    assert.ok(pid, 'a sidecar should be running');

    await new Promise((r) => setTimeout(r, 5000)); // ~5 watchdog evaluations
    const s = await statusOf();
    assert.equal(s.running, true, 'still running');
    assert.equal(s.joined, true, 'still joined');
    const pids = sidecarPids(dataDir);
    assert.deepEqual(pids, [pid], 'same single sidecar process — the watchdog never fired');

    // Observability contract: a real reading was taken and surfaced (this
    // doubles as the platform RSS-reader proof — null would mean the reader
    // stood down), nothing was restarted, and the default ceiling is echoed.
    assert.ok(typeof s.watchdog.lastRssMb === 'number' && s.watchdog.lastRssMb > 1,
      `expected a real RSS reading, saw ${JSON.stringify(s.watchdog)}`);
    assert.equal(s.watchdog.restarts, 0, 'no watchdog restarts on a healthy sidecar');
    assert.equal(s.watchdog.maxRssMb, 256, 'default ceiling echoed');
    assert.deepEqual(s.recovery, { attempts: 0, retryPending: false },
      'recovery idle on a healthy stack');
  });
});
