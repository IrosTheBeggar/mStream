/**
 * The sidecar crash-recovery loop, end to end against a real binary.
 *
 * THE OUTAGE THIS COVERS. The p2p-sidecar is a child process, so an OOM kill
 * takes it down with nobody asking. Before this, nothing put it back:
 * p2p.start() had exactly one real caller (the stack's boot), and both
 * periodic passes that could have noticed — the mesh-health watch and the
 * catalog prune — returned early on `!isRunning()`. A server ran on for hours
 * with the config saying "enabled" and nothing on the network.
 *
 * Worse, recovery DID sometimes happen by accident, and left a state that
 * looked healthier while being just as broken: publish/fetch/announce all
 * lazily start() the sidecar, so an hourly rotation fetch would respawn the
 * process WITHOUT rejoining the gossip topic — `running: true`, `joined:
 * false`, invisible forever, and the health watch skipping it because its
 * guard excluded the un-joined case outright.
 *
 * So `joined` is the assertion that matters here, not `running`. A bare
 * respawn satisfies `running`; only a full stack replay — subscribe, spawn,
 * join, re-announce, holds — satisfies `joined`. The sidecar reports
 * joined:true on an empty bootstrap set (it subscribes to the topic whether
 * or not anyone else is there), which is what lets this suite prove the
 * property with no network, no seeds and no peers at all.
 *
 * Needs a real sidecar binary (dev build in p2p-sidecar/target/release, or an
 * operator prebuilt in bin/p2p-sidecar/). CI usually has neither — the
 * binaries left git when the sidecar moved to its own repo — so this skips
 * there, exactly like the gossip layers of discovery-p2p.test.mjs.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();
// Killing a specific grandchild by pid needs a POSIX `ps`; the recovery logic
// itself is platform-independent and is unit-covered in
// test/unit/discovery-p2p-crash-recovery.test.mjs.
const SKIP = process.platform === 'win32'
  ? 'needs a POSIX ps to find the sidecar grandchild'
  : (SIDECAR_BIN ? false : 'no p2p-sidecar binary on this machine');

// The sidecar is a GRANDCHILD (test → server → sidecar), so there is no
// handle to it here. Match on the per-test data dir, which is a unique tmp
// path — never on the binary name alone, or a developer's own mStream
// running in the background would be a candidate.
function sidecarPids(dataDir) {
  const out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n')
    .filter((line) => line.includes('p2p-sidecar') && line.includes(dataDir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function pollUntil(fn, { timeoutMs = 30000, everyMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe('discovery p2p: an unexpectedly killed sidecar rejoins by itself', { skip: SKIP }, () => {
  let server;
  let statusOf;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      extraConfig: {
        discoveryP2p: {
          enabled: true,
          // Friend-to-friend mode with no friends: the topic still gets
          // joined, so `joined` stays a clean signal while the suite stays
          // hermetic. (startServer also empties the baked seeds.)
          useCommunitySeeds: false,
        },
      },
    });
    statusOf = async () =>
      (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
  });

  after(async () => { if (server) { await server.stop(); } });

  test('SIGKILL → the stack replays itself, topic subscription included', async () => {
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');

    const healthy = await pollUntil(
      async () => { const s = await statusOf(); return s.running && s.joined ? s : null; },
      { what: 'the boot stack to spawn the sidecar and join the topic' },
    );

    const before2 = sidecarPids(dataDir);
    assert.equal(before2.length, 1, 'exactly one sidecar should belong to this server');

    // The OOM killer's signal — uncatchable, so the sidecar gets no chance to
    // shut down tidily. This is the real-world failure, not a polite stop.
    process.kill(before2[0], 'SIGKILL');

    await pollUntil(
      async () => (await statusOf()).running === false,
      { what: 'the server to notice the sidecar died' },
    );

    // First backoff rung is 5s, then the spawn + join round trip.
    const recovered = await pollUntil(
      async () => { const s = await statusOf(); return s.running && s.joined ? s : null; },
      { timeoutMs: 60000, what: 'the stack to replay itself after the crash' },
    );

    assert.equal(recovered.joined, true,
      'a bare respawn would leave joined:false — recovery must replay the whole stack');

    const after2 = sidecarPids(dataDir);
    assert.equal(after2.length, 1, 'exactly one sidecar after recovery — no orphan left behind');
    assert.notEqual(after2[0], before2[0], 'the recovered sidecar must be a genuinely new process');

    // The identity key is persisted under the data dir, so the server keeps
    // the endpoint id its peers already know. A recovery that changed it
    // would strand every catalog entry pointing at this server.
    assert.equal(recovered.endpointId, healthy.endpointId,
      'recovery must keep the persisted endpoint identity');
  });

  test('re-enabling a stack whose sidecar is gone repairs it instead of answering 200 to nothing', async () => {
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');
    const [pid] = sidecarPids(dataDir);
    assert.ok(pid, 'previous test should have left a live sidecar');

    process.kill(pid, 'SIGKILL');
    await pollUntil(
      async () => (await statusOf()).running === false,
      { what: 'the server to notice the second kill' },
    );

    // What an operator does when the panel says the network is down. This
    // used to return {"enabled":true} while the stack's stale `running` flag
    // turned the call into a silent no-op.
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(r.status, 200);

    const s = await statusOf();
    assert.equal(s.running, true, 're-enable must actually respawn the sidecar');
    assert.equal(s.joined, true, 're-enable must put it back on the catalog topic');
  });

  test('an RPC that loses the race with the kill fails the request, not the server', async () => {
    // Found by this suite, and far worse than the outage it was written for:
    // between the child dying and Node delivering 'exit', `proc` is still set
    // and its stdin is a broken pipe. rpc() writes anyway, EPIPE lands on the
    // stream, and an unhandled 'error' on a stream is an uncaught exception —
    // the entire music server, library and all, going down because a status
    // poll arrived at the wrong millisecond. The status route polls exactly
    // there, so an admin watching their Discovery page during an OOM kill was
    // the trigger.
    const dataDir = path.join(server.tmpDir, 'db', 'discovery-p2p');
    await pollUntil(
      async () => { const s = await statusOf(); return s.running && s.joined ? s : null; },
      { timeoutMs: 60000, what: 'a live sidecar to race against' },
    );
    const [pid] = sidecarPids(dataDir);
    assert.ok(pid, 'need a live sidecar to kill');

    // Fire a burst of status RPCs and kill underneath them: some land before
    // the death, some inside the window, some after. Any of them may fail —
    // that is the contract, requests fail — but the process must survive.
    const burst = Promise.allSettled(
      Array.from({ length: 40 }, () => statusOf().catch(() => null)),
    );
    process.kill(pid, 'SIGKILL');
    await burst;

    const ping = await fetch(`${server.baseUrl}/api/v1/ping`);
    assert.equal(ping.status, 200,
      'a broken sidecar pipe must never take the whole server down');
  });
});
