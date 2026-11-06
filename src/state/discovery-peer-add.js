// The Add state machine behind the Peer Recommendations page: an admin
// presses "+" on a catalog peer, and the server shelves that peer's snapshot
// in the background, swapping unpinned snapshots out when the shelf is full.
//
// POST /api/v1/admin/discovery/p2p/peer-dbs/add answers at once (add()):
// 202 while the download runs or waits its turn, 200 for an outcome known
// up front (already on the shelf, or a pre-check failed), 404/409 for a
// peer the page never offers. The outcome then waits in a per-peer state
// the peers route reads (stateOf()), so every client's strip shows the same
// "Adding…", "No room" or "Try again":
//
//   (none) --POST--> pre-checks --fail--> failed{code}
//                               --ok----> adding --lands--> done
//                                                --fails--> failed{code}
//   failed --POST (Try again)--> pre-checks ...
//
// States live in memory only: a download dies with the process, so an
// "adding" remembered across a restart would lie. done lingers 5 min (long
// enough for a client polling every 3 s to see the landing and re-ask the
// taste route), failed 30 min, both checked on read. Every failed state is
// dropped on any shelf or pin change (peer-dbs onShelfChange): a snapshot
// leaving the shelf, or an unpin, may be exactly the room a "No room" was
// waiting for, and a fresh try costs one press. A download that ends
// without landing changes no shelf but frees the room it held from every
// plan made meanwhile, so it drops the "No room"s (and only those). A done
// state goes as soon as its snapshot leaves the shelf: the row is addable
// again, and done would leave it with no "+".
//
// At most two Adds download at once; the rest queue FIFO and report adding.
// An Add plans its room when it starts (planRoom, through peer-dbs
// planRoomFor; a queued Add re-plans then, since the shelf has moved) and
// always fetches first: the planned evictees ride into fetchPeer as its
// `discount` and leave the shelf in the same registry write that shelves
// the newcomer, so a failed or slow download costs no peer its place. A
// page Add never pins.
//
// The admin panel's synchronous fetch (POST …/peer-dbs/fetch) reports into
// the same states through track(), so the page shows "Adding…" while the
// panel's request is open.
//
// The p2p stack stopping (a disable, a reboot) resets everything: peer-dbs
// keeps a download from the stopped network from landing, and this module
// drops its states and queue and ignores whatever the old downloads report.

import winston from 'winston';
import * as discoveryDb from '../db/discovery-db.js';
import * as discoveryP2p from './discovery-p2p.js';
import * as discoveryCatalog from './discovery-catalog.js';
import * as peerDbs from './discovery-peer-dbs.js';
import { modelCompatible } from './discovery-peer-rotation.js';
import { peerLabels } from './discovery-peer-view.js';

const MAX_DOWNLOADS = 2;
// Room for every peer the strip can show many times over; past it, the
// oldest outcomes go first.
const MAX_STATES = 200;
const DONE_TTL_MS = 5 * 60 * 1000;
const FAILED_TTL_MS = 30 * 60 * 1000;

// The codes clients tell apart: no-room reads "No room", the rest "Try
// again". Every other shelf code (blocked, incompatible, failed, a stop
// that outran the reset) folds into failed; the raw message only reaches
// the log.
const WIRE_CODES = new Set(['no-room', 'no-disk', 'offline', 'bad-snapshot', 'gone']);
function wireCode(code) {
  return WIRE_CODES.has(code) ? code : 'failed';
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function sizeLabel(bytes) {
  return bytes >= 1048576 ? `${Math.round(bytes / 1048576)}MB` : `${Math.round(bytes / 1024)}KB`;
}

const tag = (endpointId) => `${endpointId.slice(0, 12)}…`;

function activeModel() {
  return discoveryDb.openDiscoveryDbIfExists() ? discoveryDb.getMeta('embedding_model_id') : null;
}

// Injectable for tests: the shelf (peer-dbs), the catalog, the network's
// state, the hooks, the clock and the logger. The defaults are the real
// modules, wired as the server runs them.
//
//   isRunning   whether a download can start without spawning the sidecar
//               (discovery-p2p canFetch: true under the fake fetch too)
//   onShelfChange / onStop   subscriptions; the adder registers once, here
export function createPeerAdder({
  fetchPeer = peerDbs.fetchPeer,
  planRoomFor = peerDbs.planRoomFor,
  isBlocked = peerDbs.isBlocked,
  heldEntry = peerDbs.get,
  listShelf = peerDbs.list,
  catalogEntry = discoveryCatalog.get,
  listCatalog = discoveryCatalog.list,
  seederCountOf = discoveryCatalog.seederCount,
  localModel = activeModel,
  isRunning = discoveryP2p.canFetch,
  onlineWindowMs = peerDbs.onlineWindowMs,
  onShelfChange = peerDbs.onShelfChange,
  onStop = peerDbs.onStop,
  now = () => Date.now(),
  logger = winston,
} = {}) {
  const states = new Map();  // endpointId -> { state, code, at (ms), by }, oldest write first
  const queue = [];          // endpointIds waiting for a download slot, FIFO
  let active = new Set();    // endpointIds downloading in this generation
  const running = new Set(); // every Add not yet settled, whatever its generation
  // Bumped by reset(). An Add from an older generation belongs to a stopped
  // network: whatever it reports is ignored.
  let generation = 0;

  // A peer's state, or null once its lifetime ran out (deleted on the way).
  function read(endpointId) {
    const entry = states.get(endpointId);
    if (!entry) { return null; }
    const ttl = entry.state === 'done' ? DONE_TTL_MS
      : entry.state === 'failed' ? FAILED_TTL_MS : Infinity;
    if (now() - entry.at >= ttl) {
      states.delete(endpointId);
      return null;
    }
    return entry;
  }

  function write(endpointId, state, code, by) {
    const entry = { state, code, at: now(), by };
    // Re-inserted, so the Map stays in oldest-write-first order for trim().
    states.delete(endpointId);
    states.set(endpointId, entry);
    trim();
    return entry;
  }

  // At most MAX_STATES: the oldest outcomes go first, then the oldest Adds
  // still waiting for a slot (they leave the queue too). A download already
  // running keeps its state.
  function trim() {
    for (const [id, entry] of states) {
      if (states.size <= MAX_STATES) { return; }
      if (entry.state !== 'adding') { states.delete(id); }
    }
    for (const id of states.keys()) {
      if (states.size <= MAX_STATES) { return; }
      if (active.has(id)) { continue; }
      states.delete(id);
      const at = queue.indexOf(id);
      if (at !== -1) { queue.splice(at, 1); }
    }
  }

  const wire = (endpointId, entry) => ({
    endpointId,
    state: entry.state,
    code: entry.code ?? null,
    at: new Date(entry.at).toISOString(),
  });

  function labelOf(endpointId) {
    return peerLabels({ shelf: listShelf(), catalog: listCatalog(), isBlocked }).get(endpointId) || '';
  }

  function fail(endpointId, code, message, by) {
    logger.warn(`[discovery-peer-dbs] add ${tag(endpointId)} failed (${code}): ${message}`);
    return write(endpointId, 'failed', code, by);
  }

  // The pre-checks, in the order the route's status table gives them,
  // against the shelf and catalog as they stand right now. isBlocked comes
  // before the catalog lookup: the block route also forgets the peer, and a
  // blocked peer must read as blocked, not unknown. One of
  //   { status, error, code, why }   the route refuses (404 / 409)
  //   { held: true }                 already on the shelf
  //   { code, why }                  a failure known before dialing
  //   { evictIds }                   go: fetch, then swap these out
  function assess(endpointId) {
    if (isBlocked(endpointId)) {
      return { status: 409, error: 'blocked', code: 'blocked', why: 'the peer is blocked' };
    }
    const entry = catalogEntry(endpointId);
    if (!entry) {
      return { status: 404, error: 'not-in-catalog', code: 'gone', why: 'the peer is not in the catalog' };
    }
    if (!modelCompatible(entry.payload, localModel())) {
      return {
        status: 409, error: 'incompatible', code: 'incompatible',
        why: `the peer announces another embedding model (${entry.payload.modelId || 'none'})`,
      };
    }
    if (heldEntry(endpointId)) { return { held: true }; }
    if (!isRunning()) { return { code: 'offline', why: 'the discovery network is not running' }; }
    const heard = now() - Date.parse(entry.updatedAt) < onlineWindowMs();
    if (!heard && seederCountOf(entry.payload.hash || '') === 0) {
      return { code: 'offline', why: 'not heard from lately, and no live peer holds its snapshot' };
    }
    // Room is planned on the announced size, which every mStream server
    // announces. Without one, nothing says what to swap out, and the
    // download's only ceiling would be the headroom left as it stands.
    if (!(entry.payload.size > 0)) {
      return { code: 'bad-snapshot', why: 'the peer announces no snapshot size, so no room can be planned for it' };
    }
    const plan = planRoomFor(endpointId);
    if (!plan) {
      return { status: 404, error: 'not-in-catalog', code: 'gone', why: 'the peer is not in the catalog' };
    }
    if (!plan.fits) {
      return { code: 'no-room', why: 'it does not fit under the storage cap even with every unpinned snapshot swapped out' };
    }
    return { evictIds: plan.evictIds };
  }

  // Fetch first; the evictees leave in the landing (fetchPeer's discount).
  // A no-room from fetchPeer means the shelf moved under the download (an
  // evictee pinned meanwhile, say), so re-plan against the shelf as it is
  // now: no fit is the honest "No room", a new fit is worth one more try.
  // The plan uses the announced size, and the bytes the download landed are
  // never more (an over-announced blob is a bad-snapshot).
  async function download(endpointId, evictIds, gen) {
    let discount = evictIds;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetchPeer(endpointId, { pinned: false, discount });
      } catch (err) {
        if (err.code !== 'no-room' || gen !== generation) { throw err; }
        const plan = planRoomFor(endpointId);
        if (!plan) { throw coded('gone', 'the peer left the catalog during the download'); }
        if (!plan.fits) { throw err; }
        if (attempt === 2) { throw Object.assign(new Error(err.message, { cause: err }), { code: 'failed' }); }
        discount = plan.evictIds;
      }
    }
  }

  // One Add in its download slot, to its outcome. `evictIds` is the plan
  // add() made a moment ago; a queued Add brings none and re-checks now.
  async function settle(endpointId, evictIds, gen) {
    const by = states.get(endpointId)?.by ?? null;
    try {
      let plan = evictIds;
      if (!plan) {
        const verdict = assess(endpointId);
        if (verdict.held) {
          write(endpointId, 'done', null, by);
          return;
        }
        if (verdict.code) { throw coded(verdict.code, verdict.why); }
        plan = verdict.evictIds;
      }
      const record = await download(endpointId, plan, gen);
      if (gen !== generation) { return; }
      write(endpointId, 'done', null, by);
      logger.info(`[discovery-peer-dbs] add ${tag(endpointId)} landed `
        + `(${record.rowCount} tracks, ${sizeLabel(record.sizeBytes || 0)})`);
    } catch (err) {
      if (gen !== generation) { return; }
      // The stack stopped without this adder hearing of it: no outcome to show.
      if (err.code === 'stopped') {
        states.delete(endpointId);
        return;
      }
      fail(endpointId, wireCode(err.code), err.message, by);
    }
  }

  function begin(endpointId, evictIds) {
    const gen = generation;
    const slots = active;
    slots.add(endpointId);
    const run = settle(endpointId, evictIds, gen).finally(() => {
      slots.delete(endpointId);
      running.delete(run);
      // A slot from before a reset frees nothing in the new generation.
      if (slots === active) { pump(); }
    });
    running.add(run);
  }

  function pump() {
    while (active.size < MAX_DOWNLOADS && queue.length > 0) {
      const endpointId = queue.shift();
      if (states.get(endpointId)?.state === 'adding') { begin(endpointId); }
    }
  }

  // The route's answer: { status, body }, body being the peer's add state
  // ({ endpointId, state, code, at }) or { error } for a 404 / 409.
  function add(endpointId, { by = null } = {}) {
    const verdict = assess(endpointId);
    if (verdict.error) { return { status: verdict.status, body: { error: verdict.error } }; }
    const current = read(endpointId);
    if (current?.state === 'adding') { return { status: 202, body: wire(endpointId, current) }; }
    if (verdict.held) {
      const done = current?.state === 'done' ? current : { state: 'done', code: null, at: now() };
      return { status: 200, body: wire(endpointId, done) };
    }
    const queued = !verdict.code && (active.size >= MAX_DOWNLOADS || queue.length > 0);
    logger.info(`[discovery-peer-dbs] add ${tag(endpointId)} (${labelOf(endpointId)}) `
      + `by '${by || 'unknown'}'${queued ? ', queued' : ''}`);
    if (verdict.code) {
      return { status: 200, body: wire(endpointId, fail(endpointId, verdict.code, verdict.why, by)) };
    }
    const entry = write(endpointId, 'adding', null, by);
    if (queued) {
      queue.push(endpointId);
    } else {
      begin(endpointId, verdict.evictIds);
    }
    return { status: 202, body: wire(endpointId, entry) };
  }

  // The peers route's lookup: { state, code, at (ISO), by } or null.
  function stateOf(endpointId) {
    const entry = read(endpointId);
    if (!entry) { return null; }
    return { ...wire(endpointId, entry), by: entry.by };
  }

  // The admin panel's synchronous fetch, shown as an Add while it runs.
  // `fetching` is that route's fetchPeer promise, handed back as is. It
  // never stores no-room: that state says an Add would not fit even after
  // swapping snapshots out, and this fetch never swaps, so a cap failure
  // here reads "Try again". While this adder's own Add for the peer runs or
  // waits, that Add's outcome is the one the state shows.
  function track(endpointId, fetching, { by = null } = {}) {
    if (active.has(endpointId) || queue.includes(endpointId)) { return fetching; }
    const gen = generation;
    write(endpointId, 'adding', null, by);
    fetching.then(() => {
      if (gen === generation) { write(endpointId, 'done', null, by); }
    }, (err) => {
      if (gen !== generation) { return; }
      if (err.code === 'stopped') {
        states.delete(endpointId);
        return;
      }
      write(endpointId, 'failed', err.code === 'no-room' ? 'failed' : wireCode(err.code), by);
    });
    return fetching;
  }

  // Forget every state and queued Add; downloads already running finish
  // into a generation nobody reads.
  function reset() {
    generation += 1;
    states.clear();
    queue.length = 0;
    active = new Set();
  }

  // Resolves once every Add this adder started, before or after a reset,
  // has settled (tests; a shutdown that wants to wait).
  async function whenIdle() {
    while (running.size > 0) { await Promise.allSettled([...running]); }
  }

  onShelfChange(({ endpointId, change }) => {
    for (const [id, entry] of states) {
      const stale = entry.state === 'failed'
        ? change !== 'released' || entry.code === 'no-room'
        : entry.state === 'done' && change === 'removed' && id === endpointId;
      if (stale) { states.delete(id); }
    }
  });
  onStop(reset);

  return { add, stateOf, track, reset, whenIdle };
}

// The instance the routes use.
export const peerAdder = createPeerAdder();
