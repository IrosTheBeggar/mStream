// Shelf policy for fetched peer snapshots — the PURE half of
// discovery-peer-dbs.js, split out so the selection/rotation rules are unit
// testable without a server, a sidecar, or a config singleton. Everything a
// decision needs arrives as an argument; nothing here touches disk, network,
// or clocks.
//
// Two policies live here:
//
//   candidateOrder      which unheld catalog peer is most worth downloading
//                       (used by the reconcile top-up AND by rotation)
//   planRotation        which held snapshot to swap for which candidate so
//                       shelf MEMBERSHIP cycles over time ("suggestions stay
//                       fresh") — the anti-calcification pass
//
// Rotation philosophy: the shelf only ever SWAPS (never shrinks — evicting
// with no replacement serves nobody), churns at most one pair per pass
// (gentle, self-limiting on small catalogs), never touches pinned entries,
// and prefers to evict what's least useful (long-offline, longest-held) in
// favor of what's most novel (never held before, model-compatible, online).
//
// Novelty never outranks REACHABILITY: a candidate must be fetchable right
// now — origin online, or a live holds beacon offering its snapshot — or it
// is not a candidate at all. Without that gate, the never-held-first order
// kept picking the same two long-offline peers every hour for two weeks on a
// production server: each pass a guaranteed dead dial and a warn line, noise
// that ended up masking a real outage (mStream #880).

// A peer is "online" when we heard a re-announcement recently. Announcers
// re-broadcast every ~15s; 90s tolerates a few missed rounds.
export const ONLINE_WINDOW_MS = 90 * 1000;

// Is a candidate's announced embedding space one we can actually search?
// The similarity route only ever reads rows WHERE model_id = ours, so a
// snapshot from another model (or from a server that never embedded — empty
// modelId) is pure dead weight on the shelf. AUTO paths (reconcile top-up,
// rotation) therefore skip incompatible candidates by default; the config
// escape hatch (discoveryP2p.autoFetchIncompatibleModels) and the manual
// admin fetch both exist for the deliberate cases — migration readiness,
// or seeding the swarm with snapshots we can't search ourselves. No local
// model established yet = no compatibility signal; everyone passes.
export function modelCompatible(payload, localModel, allowIncompatible = false) {
  if (allowIncompatible || !localModel) { return true; }
  return (payload.modelId || '') === localModel;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Missing/garbage timestamps parse to 0 = "the beginning of time". For
// membership ages that makes a record with no clock ELIGIBLE to rotate
// (conservative: unknown age is treated as old, and rotation is harmless —
// snapshots are re-fetchable cache); for last-heard it sorts an unknown
// peer as longest-silent, the first to evict.
function ts(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Sort candidates by usefulness: peers whose announced embedding model
// matches ours first, then peers we can hear right now, then by library
// size. The model term only bites when incompatible candidates are in the
// pool at all — i.e. when autoFetchIncompatibleModels opted back in, or no
// local model exists yet (no compatibility signal; everyone ties).
export function candidateOrder(localModel, now = Date.now()) {
  return (a, b) => {
    if (localModel) {
      const aCompat = a.payload.modelId === localModel ? 1 : 0;
      const bCompat = b.payload.modelId === localModel ? 1 : 0;
      if (aCompat !== bCompat) { return bCompat - aCompat; }
    }
    const aOnline = now - ts(a.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
    const bOnline = now - ts(b.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
    if (aOnline !== bOnline) { return bOnline - aOnline; }
    return (b.payload.rowCount || 0) - (a.payload.rowCount || 0);
  };
}

// Rotation's candidate order: novelty first — a peer we've NEVER shelved
// beats every past evictee, and among past evictees the longest-gone comes
// back first (no A↔B ping-pong while unheld peers wait). Ties fall through
// to the regular usefulness order.
export function rotationCandidateOrder(ledger, localModel, now = Date.now()) {
  const base = candidateOrder(localModel, now);
  return (a, b) => {
    const aEvicted = ts(ledger[a.from]); // 0 = never held here
    const bEvicted = ts(ledger[b.from]);
    if (aEvicted !== bEvicted) { return aEvicted - bEvicted; }
    return base(a, b);
  };
}

// Which held snapshot is least worth keeping: peers we can't hear at all
// go first (longest-silent first among them — their data only ages, no
// refresh is coming), then the longest-standing membership. Tie-break
// prefers evicting a snapshot OTHER live peers still hold (seeders ≥ 2),
// so rotation avoids deleting the swarm's last copy when it has a choice.
function evictionOrder(catalogByFrom, seederCountOf, now) {
  return (a, b) => {
    const aCat = catalogByFrom.get(a.endpointId);
    const bCat = catalogByFrom.get(b.endpointId);
    const aOnline = aCat && now - ts(aCat.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
    const bOnline = bCat && now - ts(bCat.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
    if (aOnline !== bOnline) { return aOnline - bOnline; }
    if (!aOnline) {
      const aHeard = aCat ? ts(aCat.updatedAt) : 0;
      const bHeard = bCat ? ts(bCat.updatedAt) : 0;
      if (aHeard !== bHeard) { return aHeard - bHeard; }
    }
    const aStart = ts(a.firstFetchedAt);
    const bStart = ts(b.firstFetchedAt);
    if (aStart !== bStart) { return aStart - bStart; }
    return seederCountOf(b.hash) - seederCountOf(a.hash);
  };
}

// One rotation decision: `{ evictId, fetchId, evictFirst } | null`.
//
//   shelf          registry entries ({ endpointId, hash, sizeBytes, pinned,
//                  firstFetchedAt, ... })
//   catalog        discovery-catalog list() entries ({ from, updatedAt,
//                  payload: { size, rowCount, modelId, ... } })
//   ledger         { endpointId -> evictedAt ISO } — past rotation evictions
//   localModel     active embedding model id, or null when none established
//   rotationDays   0 disables rotation entirely
//   autoFetch/autoFetchCount   rotation is an auto-fetch behavior: a paused
//                  shelf (feature off, or count 0) must not keep swapping
//   capBytes       the storage cap; a candidate must fit AFTER the eviction
//   allowIncompatibleModels    config escape hatch: rotation is an AUTO
//                  fetch, so model-incompatible candidates are not
//                  candidates unless the operator opted back in
//   isBlocked / inBackoff / seederCountOf   injected lookups (pure-testable)
//
// evictFirst is true when the incoming snapshot only fits once the evictee's
// bytes are gone — the caller must then evict before fetching and accept the
// small window where the fetch fails and the shelf runs one short. When it
// fits in current headroom the caller fetches FIRST, so a failed download
// costs nothing.
export function planRotation({
  shelf, catalog, ledger, localModel, now,
  rotationDays, autoFetch, autoFetchCount, capBytes,
  allowIncompatibleModels = false,
  isBlocked = () => false,
  inBackoff = () => false,
  seederCountOf = () => 0,
}) {
  if (!autoFetch || !(autoFetchCount > 0) || !(rotationDays > 0)) { return null; }

  const eligible = shelf.filter((e) => e.pinned !== true
    && now - ts(e.firstFetchedAt || e.fetchedAt) >= rotationDays * DAY_MS);
  if (eligible.length === 0) { return null; }

  const held = new Set(shelf.map((e) => e.endpointId));
  // Fetchable = someone can actually serve the snapshot right now: the
  // origin announced within the online window, or a live (TTL-pruned) holds
  // beacon lists the hash — the swarm path fetches from any live holder, so
  // an offline origin with live seeders is still a perfectly good pick.
  const fetchable = (c) => now - ts(c.updatedAt) < ONLINE_WINDOW_MS
    || seederCountOf(c.payload.hash || '') > 0;
  const candidates = catalog
    .filter((c) => !held.has(c.from) && !isBlocked(c.from) && !inBackoff(c.from)
      && modelCompatible(c.payload, localModel, allowIncompatibleModels)
      && fetchable(c))
    .sort(rotationCandidateOrder(ledger, localModel, now));
  if (candidates.length === 0) { return null; }

  const catalogByFrom = new Map(catalog.map((c) => [c.from, c]));
  const evict = [...eligible].sort(evictionOrder(catalogByFrom, seederCountOf, now))[0];

  const totalBytes = shelf.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
  const headroomAfterEvict = capBytes - (totalBytes - (evict.sizeBytes || 0));
  const incoming = candidates.find((c) => (c.payload.size || 0) <= headroomAfterEvict);
  if (!incoming) { return null; }

  return {
    evictId: evict.endpointId,
    fetchId: incoming.from,
    evictFirst: (incoming.payload.size || 0) > capBytes - totalBytes,
  };
}
