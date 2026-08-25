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
// Security posture: a malicious seed cannot forge catalog entries
// (announcements are origin-signed) and cannot observe queries (those never
// leave each machine). It COULD try to eclipse a brand-new node —
// mitigations are multiple independent seeds, the user's own bootstrapPeers
// bypassing seeds entirely, and the remote list being ed25519-SIGNED by an
// offline maintainer key (discovery-seeds-verify.js): an unsigned/tampered
// list — hijacked repo, tampering mirror, TLS middlebox — is treated as a
// failed fetch, and a replayed OLD signed list is rejected by its `seq`
// against the cached copy. Fallback order stays cache → baked; boot never
// depends on the URL.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from './config.js';
import * as discoveryP2p from './discovery-p2p.js';
import { verifySeedList } from './discovery-seeds-verify.js';

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
  {
    // DigitalOcean, EU Central (euc1 relay) — a second independent region
    // so bootstrap has no single point of failure.
    name: 'seed-eu-1',
    endpointId: 'd7d3f4501a5a70e17ea93106f303b77714d5625e9849aa4ebaff6d0c5d4b2260',
    ticket: 'endpointadl5h5cqdjnhbyl6veyqn4ydw53rjvlcl2metksoxl7w2dc5jmrgaayaenuhi5dqom5c6l3fovrtcljrfzzgk3dbpexg4mbonfzg62bonruw42zof4aqbhpvij2yz5icaeakyeiaakgpkaq',
  },
];

// Test-only override for the baked list above (same precedent as
// MSTREAM_TEST_SEEDS_PUBKEY in discovery-seeds-verify.js): a JSON array of
// {name, endpointId, ticket} entries that REPLACES DEFAULT_SEEDS. The test
// helper sets '[]' for every spawned server so no suite can bootstrap into
// the real network through the shipped tickets — resolveBootstrap() UNIONS
// baked + fetched, so a seed-mechanics suite that re-enables
// useCommunitySeeds for its stub list would otherwise still join the real
// seeds and gossip its fake announcements into real users' catalogs (the
// 2026-07-27 "Stranger" ghost peers). Set-but-unusable fails CLOSED to an
// empty list, never open to DEFAULT_SEEDS: a typo'd override must not mean
// "join production". Production installs never set this.
function bakedSeeds() {
  const raw = process.env.MSTREAM_TEST_BAKED_SEEDS;
  if (raw === undefined) { return DEFAULT_SEEDS; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { throw new Error('not an array'); }
    return parsed;
  } catch (err) {
    winston.warn(`MSTREAM_TEST_BAKED_SEEDS is set but unusable (${err.message}) — treating it as an empty list`);
    return [];
  }
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_SEEDS = 20;            // sanity cap on a fetched list
const MAX_TICKET_LEN = 4096;
// Mesh-health watch: if we're joined but have heard nobody for this long,
// re-resolve (fresh remote fetch) and re-join — covers seed rotation that
// happened after this release shipped. The same tick carries the sidecar
// memory watchdog below. Env override mirrors MSTREAM_TEST_DISCOVERY_ROTATE_MS.
const HEALTH_INTERVAL_MS =
  Number(process.env.MSTREAM_TEST_DISCOVERY_HEALTH_MS) || 5 * 60 * 1000;

// Sidecar memory watchdog state, surfaced for the p2p status route. The
// counter is per-process (not persisted): it exists so a RECURRING breach
// reads as a pattern in the admin panel instead of a mystery of repeating
// one-off log lines.
let watchdogRestarts = 0;
let lastSidecarRssMb = null;
export function getWatchdogState() {
  return { restarts: watchdogRestarts, lastRssMb: lastSidecarRssMb };
}

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

// Parse + AUTHENTICATE a seed list (remote fetch or disk cache — one code
// path, so a tampered cache file is caught too). Throws on anything less
// than a well-formed, correctly signed document; callers treat that as a
// failed fetch. Returns { seq, seeds }.
function parseSeedList(raw) {
  const doc = JSON.parse(raw);
  if (!doc || doc.version !== 1 || !Array.isArray(doc.seeds)) {
    throw new Error('unrecognized seed-list shape (want {version:1, seeds:[...]})');
  }
  verifySeedList(doc);
  return { seq: doc.seq, seeds: doc.seeds.filter(validEntry).slice(0, MAX_SEEDS) };
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
    if (!forceRefresh && Date.now() - stat.mtimeMs < CACHE_TTL_MS) { return cached.seeds; }
  } catch (err) {
    // No cache is normal (first boot). A cache that EXISTS but won't verify
    // is worth a note — expected once right after upgrading from the
    // pre-signing release, alarming any other time.
    if (err.code !== 'ENOENT') {
      winston.warn(`cached community seed list rejected (${err.message}) — ignoring it`);
    }
  }
  if (localOnly) { return cached ? cached.seeds : []; }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(config.program.discoveryP2p.seedListUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const raw = await res.text();
    const fetched = parseSeedList(raw);
    // Rollback protection: a validly signed but OLDER list never replaces a
    // newer one we've already verified — replaying a stale list can't
    // resurrect a rotated-out seed.
    if (cached && fetched.seq < cached.seq) {
      winston.warn(`fetched community seed list is older than the cached one `
        + `(seq ${fetched.seq} < ${cached.seq}) — keeping the cached copy`);
      return cached.seeds;
    }
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), raw);
    return fetched.seeds;
  } catch (err) {
    winston.warn(`community seed list fetch failed (${err.message}) — using ${cached ? 'cached copy' : 'baked defaults only'}`);
    return cached ? cached.seeds : [];
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
    config.program.discoveryP2p.useCommunitySeeds ? bakedSeeds() : [],
    remote,
    config.program.discoveryP2p.bootstrapPeers,
    config.program.discoveryP2p.blockedPeers,
  );
}

// Watch the mesh after boot: a running sidecar that is off the topic, or on
// it with zero neighbors for a full interval, means our bootstrap set is
// stale or the peers are gone — re-resolve with a forced list refresh and
// join again (join_peers is idempotent, so this can never hurt an
// already-healthy mesh). Idempotent across server reboot()s.
//
// NOTE the un-joined case is included deliberately. It used to be excluded
// (`if (!s.joined || ...) return`), which skipped the single most broken
// state a live sidecar can be in — and that state is reachable, because
// publish/fetch/announce all lazily start() the sidecar WITHOUT joining it.
// A rotation fetch respawning a crashed sidecar therefore left the server
// permanently silent: process up, topic un-subscribed, and the one watch
// that could have noticed bailing on the very condition it should repair.
let watchTimer = null;
export function startMeshHealthWatch() {
  if (watchTimer) { return; }
  watchTimer = setInterval(async () => {
    try {
      if (!discoveryP2p.isRunning()) { return; }
      // Memory watchdog FIRST — it must run on every tick, and the mesh
      // checks below early-return on a healthy mesh (a mesh-healthy sidecar
      // can still be a bloating one; that combination was exactly the #880
      // outage's first 102 hours). On breach: kill and stand back — the
      // exit classifies as unexpected, crash recovery replays the whole
      // stack, and this watch's next ticks see a fresh sidecar. Ceiling 0
      // disables. A null reading (unsupported platform, exit race) stands
      // down rather than guessing.
      const ceiling = config.program.discoveryP2p.sidecarMaxRssMb;
      if (ceiling > 0) {
        const rss = await discoveryP2p.sidecarRssMb();
        lastSidecarRssMb = rss;
        if (rss !== null && rss > ceiling) {
          watchdogRestarts += 1;
          winston.warn(`[discovery-seeds] sidecar RSS ${Math.round(rss)}MB exceeds the `
            + `${ceiling}MB ceiling (discoveryP2p.sidecarMaxRssMb) — killing it so crash `
            + `recovery replays the stack (watchdog restart #${watchdogRestarts})`);
          discoveryP2p.killSidecarForRestart();
          return;
        }
      }
      const s = await discoveryP2p.status();
      if (s.joined && s.neighbors > 0) { return; }
      const bootstrap = await resolveBootstrap({ forceRefresh: true });
      if (bootstrap.length === 0) { return; } // nothing to join with — nothing to do
      winston.info(`[discovery-seeds] ${s.joined ? 'no mesh neighbors' : 'sidecar is not on the catalog topic'} `
        + `— re-joining with ${bootstrap.length} bootstrap peer(s)`);
      await discoveryP2p.join(bootstrap);
    } catch (err) {
      winston.warn(`[discovery-seeds] mesh health check failed: ${err.message}`);
    }
  }, HEALTH_INTERVAL_MS);
  if (watchTimer.unref) { watchTimer.unref(); }
}

// The disable half — without it a runtime-disabled server would keep
// probing the (stopped) sidecar every health interval and warn-spam.
export function stopMeshHealthWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}
