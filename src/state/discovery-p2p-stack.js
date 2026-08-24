// The discovery-p2p runtime stack — sidecar process, gossip-catalog
// subscription, community-seed join, snapshot auto-publish, peer auto-fetch —
// as ONE idempotent start/stop pair. Server boot and the admin
// enable/disable route both call this, so toggling the feature at runtime
// replays exactly what a reboot would do (the announceCurrentSnapshot
// precedent: one code path, never two drifting copies).
//
// Errors THROW from here; callers pick the policy — boot logs and leaves the
// feature off for the session, the admin route rolls the config flag back
// and returns the cause. Dynamic imports keep the p2p modules out of memory
// for the (default) servers that never enable the feature.

import winston from 'winston';

let running = false;
let starting = null;
let stopping = null;

export function isStackRunning() { return running; }

// Recovery backoff after an unexpected sidecar death. Short first — the
// common cause is a one-off OOM kill, and seconds off the mesh cost nothing
// — then widening, so a sidecar that CANNOT stay up (bad binary, wedged data
// dir, a memory limit it will always hit) settles at ~12 attempts an hour
// instead of hot-looping. It never gives up: the failure this fixes is a
// server quietly staying off the network forever, and a recovery loop that
// exhausts itself would just reintroduce it with extra steps.
const RECOVERY_DELAYS_MS = [5000, 15000, 60000, 300000];
let recoveryTimer = null;
let recoveryAttempts = 0;

function cancelRecovery() {
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
  recoveryAttempts = 0;
}

// Called by discovery-p2p.js when the child died without us asking. Replays
// the ENTIRE stack — subscribe, spawn, join, re-announce, holds — because
// everything the sidecar knew about the mesh died with the process.
function scheduleRecovery(why) {
  // `running` is the feature's INTENT. A crash leaves it true (that is the
  // stale flag this module also repairs below), so this reads "we are
  // supposed to be on the network"; a deliberate stop clears it first and
  // therefore silences recovery, which is exactly right.
  if (!running || recoveryTimer) { return; }
  const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempts, RECOVERY_DELAYS_MS.length - 1)];
  recoveryAttempts += 1;
  winston.warn(`[discovery-p2p] sidecar ${why} — replaying the stack in `
    + `${Math.round(delay / 1000)}s (attempt ${recoveryAttempts})`);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (!running) { return; }
    // Clear the dead sidecar's stale intent HERE so the start below does the
    // real work instead of tripping the "already running" guard.
    running = false;
    startDiscoveryP2pStack()
      .then(() => winston.info('[discovery-p2p] sidecar recovered — rejoined the catalog topic'))
      .catch((err) => {
        winston.warn(`[discovery-p2p] sidecar recovery failed: ${err.message}`);
        // Re-arm: startDiscoveryP2pStack() left `running` false on failure,
        // and scheduleRecovery reads it as "give up". The intent has not
        // changed — the config still says enabled — so restore it.
        running = true;
        scheduleRecovery('recovery failed');
      });
  }, delay);
  if (recoveryTimer.unref) { recoveryTimer.unref(); }
}

export async function startDiscoveryP2pStack() {
  // Serialize behind an in-flight stop. A soft reboot stops the stack and then
  // re-serves, and stopping the sidecar can take up to ~10s (a shutdown RPC
  // grace plus a SIGKILL fallback). Without this wait, the restart raced the
  // teardown: it saw the not-yet-cleared `running`, returned as a silent no-op,
  // and the late stop then killed the sidecar — leaving the config saying
  // "enabled", the admin panel reporting success, and NOTHING actually
  // gossiping or publishing, with no error logged anywhere until a full
  // restart. Waiting is what makes the restart real.
  if (stopping) {
    try { await stopping; } catch (_err) { /* stop's own caller logs it */ }
  }
  if (running) {
    // `running` records that a start COMPLETED — never that the sidecar is
    // still alive. An OOM kill or a crash leaves it stale, and this is the
    // route the admin "enable the network" button lands on: it answered 200
    // {"enabled":true} while repairing precisely nothing, which is the worst
    // possible reply to an operator trying to fix an outage. Ask the sidecar
    // itself, and if it is gone treat THIS call as the repair it looks like.
    // The import is free here: a true `running` means the module is resident.
    const p2p = await import('./discovery-p2p.js');
    if (p2p.isRunning()) { return; }
    winston.warn('[discovery-p2p] the stack is marked running but the sidecar is gone — replaying the start');
    running = false;
  }
  if (starting) { return starting; }
  starting = (async () => {
    const p2p = await import('./discovery-p2p.js');
    const catalog = await import('./discovery-catalog.js');
    const seeds = await import('./discovery-seeds.js');
    catalog.subscribe();
    // Armed BEFORE the spawn, so a sidecar that dies seconds into its life
    // is covered too. Idempotent — re-registering just replaces the slot.
    p2p.setUnexpectedExitHandler(scheduleRecovery);
    await p2p.start();
    // Two-phase bootstrap. Phase one joins the topic IMMEDIATELY with
    // what's known locally (baked seeds + cached list + the operator's
    // bootstrapPeers) — the subscription must never wait on a network
    // fetch, both for start speed and so peers bootstrapping off OUR
    // ticket find a live topic. Phase two refreshes the community list
    // and merges any additions (join is idempotent via join_peers).
    await p2p.join(await seeds.resolveBootstrap({ localOnly: true }));
    seeds.startMeshHealthWatch();
    seeds.resolveBootstrap().then((full) => p2p.join(full)).catch((err) => {
      winston.warn(`[discovery-seeds] community list refresh failed: ${err.message}`);
    });
    try {
      // Builds the export first when the collected dataset is ahead of
      // (or has never had) a snapshot — a server whose embeddings
      // finished while p2p was off still shows up on the network.
      const r = await p2p.maybeAutoPublishSnapshot({ announceEvenIfFresh: true });
      if (!r.published) {
        winston.info('[discovery-p2p] catalog joined; nothing to announce yet (no discovery data)');
      }
    } catch (err) {
      winston.warn(`[discovery-p2p] catalog joined; snapshot announce failed: ${err.message}`);
    }
    // Auto-fetch: keep a local shelf of the best catalog peers' snapshots
    // so the /api/v1/discovery/p2p/similar surface has data to search the
    // moment users ask. Event-driven + periodic; all failures are per-peer
    // logged, never fatal.
    const peerDbs = await import('./discovery-peer-dbs.js');
    peerDbs.startAutoFetch();
    // Retention pruning: forget catalog peers not heard from in
    // discoveryP2p.peerRetentionDays. The shelf is the pin-set — a peer
    // whose snapshot we hold stays listed however long it's been silent.
    catalog.startPruning(() => new Set(peerDbs.list().map((e) => e.endpointId)));
    running = true;
    // We are on the network again: retire any pending retry and reset the
    // backoff, so the NEXT crash starts from 5s rather than wherever this
    // one's ladder left off.
    cancelRecovery();
  })();
  try { await starting; } finally { starting = null; }
}

// Timers first so nothing re-touches the sidecar mid-shutdown, then the
// process itself. Catalog + shelf files stay on disk — a re-enable (or the
// next boot) picks up right where this left off.
export async function stopDiscoveryP2pStack() {
  if (stopping) { return stopping; }
  // `running` states INTENT, not completion: clear it before the first await,
  // so a start that arrives mid-teardown waits on `stopping` above instead of
  // seeing a stale `true` and no-oping. Clearing it only after p2p.stop()
  // resolved was the bug — the window is seconds wide, and a reboot lands
  // squarely inside it.
  running = false;
  // A pending retry outlives the flag it reads, so drop it here as well —
  // otherwise a crash landing just before an operator disables the feature
  // would resurrect the sidecar seconds after they turned it off.
  cancelRecovery();
  stopping = (async () => {
    const seeds = await import('./discovery-seeds.js');
    const peerDbs = await import('./discovery-peer-dbs.js');
    const catalog = await import('./discovery-catalog.js');
    seeds.stopMeshHealthWatch();
    peerDbs.stopAutoFetch();
    catalog.stopPruning();
    const p2p = await import('./discovery-p2p.js');
    // Nothing to recover from a shutdown we asked for. (stop() also bumps
    // its generation counter, so the exit is classified as expected anyway —
    // this is the belt to that suspenders.)
    p2p.setUnexpectedExitHandler(null);
    await p2p.stop();
  })();
  try { await stopping; } finally { stopping = null; }
}
