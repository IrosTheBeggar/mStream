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
  if (running) { return; }
  if (starting) { return starting; }
  starting = (async () => {
    const p2p = await import('./discovery-p2p.js');
    const catalog = await import('./discovery-catalog.js');
    const seeds = await import('./discovery-seeds.js');
    catalog.subscribe();
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
  stopping = (async () => {
    const seeds = await import('./discovery-seeds.js');
    const peerDbs = await import('./discovery-peer-dbs.js');
    const catalog = await import('./discovery-catalog.js');
    seeds.stopMeshHealthWatch();
    peerDbs.stopAutoFetch();
    catalog.stopPruning();
    const p2p = await import('./discovery-p2p.js');
    await p2p.stop();
  })();
  try { await stopping; } finally { stopping = null; }
}
