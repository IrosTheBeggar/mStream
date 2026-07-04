// Community seed nodes: how a fresh server finds the discovery network
// without knowing anybody.
//
// A seed is a well-known, always-on gossip-mesh member (the standalone
// mstream-discovery-seed binary — a separate repo; it relays but never
// announces). Its endpoint ticket is public knowledge. New servers bootstrap
// off the seeds, HyParView weaves them into the real mesh, and from then on
// they know actual peers — seeds are training wheels, not hubs.
//
// The bootstrap set a server joins with is the union of three sources:
//   1. DEFAULT_SEEDS      baked into each release (below)
//   2. the remote list    seeds/discovery-seeds.json fetched from the repo —
//                         rotating seeds is a commit, not a release. Cached
//                         on disk (~daily refresh); fetch failure falls back
//                         cache → baked. Boot never depends on the URL.
//   3. config bootstrapPeers   the operator's own friends — always additive
// minus config blockedPeers (seed entries carry their endpointId so the
// blocklist applies to them; bare-id bootstrapPeers are filterable too,
// opaque tickets pass through — documented limitation).
//
// Security posture (deliberate, documented): a malicious seed cannot forge
// catalog entries (announcements are origin-signed) and cannot observe
// queries (those never leave each machine). It COULD try to eclipse a
// brand-new node — mitigations are multiple independent seeds, the user's
// own bootstrapPeers bypassing seeds entirely, and HTTPS+GitHub as the
// list's trust anchor. List signing is a planned upgrade, not a v1 feature.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from './config.js';
import * as discoveryP2p from './discovery-p2p.js';

// Baked-in seed entries, same shape as the remote list: {name, endpointId,
// ticket}. These are the zero-network fallback (first boot, offline hosts,
// GitHub unreachable); the remote seeds/discovery-seeds.json supersedes for
// rotation. Keep this list in lockstep with that file.
export const DEFAULT_SEEDS = [
  {
    // DigitalOcean, Australia — deliberately far from the northern-
    // hemisphere user base as a worst-case latency proof (antipodal mesh
    // join measured ~1.7s; peers connect directly after introduction).
    name: 'seed-au-1',
    endpointId: 'c961437a8ff60617d7b36b5bca0e866e9521b5194e8068de08a731631418b00b',
    ticket: 'endpointadewcq32r73amf6xwnvvxsqoqzxjkinvdfhia2g6bcttcyyudcyawayaenuhi5dqom5c6l3bobztcljrfzzgk3dbpexg4mbonfzg62bonruw42zof4aqblaraabjbwqdaeancjs65kinuay',
  },
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_SEEDS = 20;            // sanity cap on a fetched list
const MAX_TICKET_LEN = 4096;
// Mesh-health watch: if we're joined but have heard nobody for this long,
// re-resolve (fresh remote fetch) and re-join — covers seed rotation that
// happened after this release shipped.
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;

function cachePath() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p', 'seeds-cache.json');
}

// Shape-check one seed entry from an untrusted source (the remote list is
// HTTPS-from-GitHub, but validate anyway — a bad deploy shouldn't wedge boot).
function validEntry(e) {
  return e && typeof e === 'object'
    && typeof e.ticket === 'string' && e.ticket.length >= 16 && e.ticket.length <= MAX_TICKET_LEN
    && (e.endpointId === undefined || (typeof e.endpointId === 'string' && /^[0-9a-f]{64}$/.test(e.endpointId)));
}

function parseSeedList(raw) {
  const doc = JSON.parse(raw);
  if (!doc || doc.version !== 1 || !Array.isArray(doc.seeds)) {
    throw new Error('unrecognized seed-list shape (want {version:1, seeds:[...]})');
  }
  return doc.seeds.filter(validEntry).slice(0, MAX_SEEDS);
}

// Merge seed entries + the operator's own bootstrapPeers into the final
// bootstrap array (of tickets/ids), applying the blocklist where an id is
// known. Pure — unit-testable without config or network.
export function mergeSeedLists(baked, remote, userPeers, blockedPeers) {
  const blocked = new Set(blockedPeers || []);
  const out = [];
  const seen = new Set();
  for (const entry of [...(baked || []), ...(remote || [])]) {
    if (!validEntry(entry)) { continue; }
    if (entry.endpointId && blocked.has(entry.endpointId)) { continue; }
    if (seen.has(entry.ticket)) { continue; }
    seen.add(entry.ticket);
    out.push(entry.ticket);
  }
  for (const peer of (userPeers || [])) {
    if (typeof peer !== 'string' || seen.has(peer)) { continue; }
    // A bare endpoint id is filterable; an opaque ticket passes through.
    if (/^[0-9a-f]{64}$/.test(peer) && blocked.has(peer)) { continue; }
    seen.add(peer);
    out.push(peer);
  }
  return out;
}

// The remote list, disk-cached. Returns [] rather than throwing — every
// failure path is a WARN plus a fallback, never a boot problem.
// localOnly: cache-or-nothing, no network — the boot path's phase one.
async function remoteSeeds({ forceRefresh = false, localOnly = false } = {}) {
  if (!config.program.discoveryP2p.useCommunitySeeds) { return []; }

  let cached = null;
  try {
    const stat = fs.statSync(cachePath());
    cached = parseSeedList(fs.readFileSync(cachePath(), 'utf8'));
    if (!forceRefresh && Date.now() - stat.mtimeMs < CACHE_TTL_MS) { return cached; }
  } catch (_err) { /* no cache yet, or unreadable — fetch below */ }
  if (localOnly) { return cached || []; }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(config.program.discoveryP2p.seedListUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const raw = await res.text();
    const seeds = parseSeedList(raw);
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), raw);
    return seeds;
  } catch (err) {
    winston.warn(`community seed list fetch failed (${err.message}) — using ${cached ? 'cached copy' : 'baked defaults only'}`);
    return cached || [];
  }
}

// The full bootstrap set for gossip join. With {localOnly:true} this is
// network-free (baked + disk cache + config) — the boot path joins with
// that IMMEDIATELY so the topic subscription never waits on a fetch, then
// phase two re-resolves with the network and join_peers()-merges any
// additions. Without localOnly it may block ≤10s on the list fetch.
export async function resolveBootstrap(opts = {}) {
  const remote = await remoteSeeds(opts);
  return mergeSeedLists(
    config.program.discoveryP2p.useCommunitySeeds ? DEFAULT_SEEDS : [],
    remote,
    config.program.discoveryP2p.bootstrapPeers,
    config.program.discoveryP2p.blockedPeers,
  );
}

// Watch the mesh after boot: joined-but-zero-neighbors for a full interval
// means our bootstrap set is stale or the peers are gone — re-resolve with a
// forced list refresh and join again (join_peers is idempotent, so this can
// never hurt an already-healthy mesh). Idempotent across server reboot()s.
let watchTimer = null;
export function startMeshHealthWatch() {
  if (watchTimer) { return; }
  watchTimer = setInterval(async () => {
    try {
      if (!discoveryP2p.isRunning()) { return; }
      const s = await discoveryP2p.status();
      if (!s.joined || s.neighbors > 0) { return; }
      const bootstrap = await resolveBootstrap({ forceRefresh: true });
      if (bootstrap.length === 0) { return; } // nothing to join with — nothing to do
      winston.info(`[discovery-seeds] no mesh neighbors — re-joining with ${bootstrap.length} bootstrap peer(s)`);
      await discoveryP2p.join(bootstrap);
    } catch (err) {
      winston.warn(`[discovery-seeds] mesh health check failed: ${err.message}`);
    }
  }, HEALTH_INTERVAL_MS);
  if (watchTimer.unref) { watchTimer.unref(); }
}
