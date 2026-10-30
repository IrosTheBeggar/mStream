// Discovery-over-federation, caller side: find music you DON'T have on the
// servers you PAIRED with, that sounds like music you DO have — and unlike
// the public p2p network's metadata-only leads, every result lives inside a
// library the peer granted us, so it is streamable over the same bridge.
//
// Namespace contract (by data source, like the rest of the discovery API):
//   /api/v1/discovery/local/*        your own library (in-memory index)
//   /api/v1/discovery/p2p/*          fetched public-network snapshots
//   /api/v1/discovery/federation/*   live queries to federated peers (this)
//
// Flow per request: resolve the query vector, fan it out to every peer with
// use_discovery on (POST /api/v1/federation/discovery/similar via fedFetch,
// bounded by a per-peer deadline), then merge: caller-side novelty chain
// (db/discovery-novelty.js), cross-peer dedupe, sort, cap. A peer whose
// dial failed twice in a row (deadline missed, handshake refused) is not
// dialed again for 60 s, doubling up to 10 min while it keeps failing
// (peerFailures), and is reported unreachable at once meanwhile; an answer,
// or the admin's successful test-connection, resets it, and a call naming
// one peer always dials. A failure while THIS server's own federation
// endpoint is down (booting, rebooting, just enabled) is no miss: the peer
// was never asked.
// A peer is untrusted, and the Discover page reads every peer's answer on
// every open: it is asked for uncompressed, and an answer that comes
// compressed or past PEER_ANSWER_MAX_BYTES is refused unread (readPeerAnswer
// — the peer answered, so no miss either); the merge looks at no more rows
// than the peer was asked for, and keeps only rows it can rank (a finite
// similarity), each bounded the way a recommendation is (mergePeerAnswers).
// The fan-out (fanOutFederation) is shared by the per-song route below,
// whose query is one local track's embedding, and the history-seeded
// Discover page (api/discovery-taste.js), whose query is a centroid of the
// page's seeds.
//
// Privacy note, stated where the code sends it: the query VECTOR leaves the
// machine, to peers the admin explicitly paired with — that is the deal the
// per-peer use_discovery toggle governs. It is one track's embedding from
// the per-song route, or, from the Discover page, a centroid of a random
// batch of up to 12 songs the user finished in the chosen window (all time
// with window 0) plus any songs they pinned: one
// averaged vector, never the songs' names, paths or hashes, but still
// derived from what this user listens to.
// The public-network contract ("queries never leave the machine",
// api/discovery-p2p.js) is unchanged.

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as fedDb from '../db/federation.js';
// Already in the boot graph (api/federation-browse.js imports it); loading it
// loads no native code — that stays in its start().
import { getEndpointId } from '../state/federation.js';
import { localIdentitySets, isNovel, norm } from '../db/discovery-novelty.js';
import { resolveSeedTrack } from './discovery.js';
import { repairRecommendation } from '../discovery-plugins/recommendation.js';
import { joiValidate } from '../util/validation.js';
import { toIso } from '../stats/time.js';
import WebError from '../util/web-error.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
// Ask each peer for more than we'll show: the novelty chain and cross-peer
// dedupe run AFTER the peers answer, so headroom keeps a heavily-filtered
// answer from coming up short. Capped at the peer endpoint's own MAX_LIMIT.
const HEADROOM = 3;
const PEER_LIMIT_CAP = 100;
// The most a peer's answer may weigh. A full one, PEER_LIMIT_CAP rows of a
// few hundred bytes each, is tens of KB: this leaves room for long names and
// paths, and still keeps a peer (hostile, or a bug) from handing every
// Discover open megabytes to parse, hold and send on. It counts the bytes
// as sent, which is why the answer must come uncompressed: Bun's fetch
// inflates a compressed body as it arrives, before the read sees a byte, so
// a small gzip answer could still cost a burst of memory (measured on Bun
// 1.4.3: about +125 MB of peak RSS for 500 KB that inflates to 500 MB).
export const PEER_ANSWER_MAX_BYTES = 1024 * 1024;
// A slow peer must not hold the Discover panel hostage; unreachable peers
// surface in `searched.unreachable`, not as an error.
const PEER_TIMEOUT_MS = 4000;
// …and an offline peer must not cost every call that whole deadline. After
// this many failed dials in a row (the deadline missed, or the handshake
// refused) it sits out a cool-down. One miss is not proof: a dial made
// while this endpoint is still finding its relay, or across a peer's
// restart, can fail once. (A dial this server could not make at all, its
// own endpoint down, is no miss: fanOutFederation's notAMiss.)
export const PEER_MISSES_BEFORE_COOLDOWN = 2;
// The first cool-down, doubling per further miss up to the cap. Test
// override, same pattern as MSTREAM_TEST_FED_FLUSH_MS
// (api/federation-limits.js): production installs never set it.
export const PEER_RETRY_AFTER_MS = Number(process.env.MSTREAM_TEST_PEER_RETRY_MS) || 60 * 1000;
export const PEER_RETRY_MAX_MS = 10 * 60 * 1000;
// How often a peer's answer may refresh its federation_peers status row.
// The Discover page fans out on every open; the admin UI's "last seen" only
// needs minute-grained truth, not a write per query per peer.
const STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;

let fedClientModule = null;   // state/federation-client.js, once a fan-out loaded it

// AbortSignal.timeout on the fetch only bounds the HTTP request THROUGH an
// established bridge — a dead peer stalls in the iroh DIAL that rebuilds
// the bridge first, which the signal never covers (measured ~29s against a
// stopped peer in the 2026-07-11 WAN smoke). Race the whole fedFetch call
// against a deadline instead; a dial that eventually succeeds in the
// background still warms the bridge for the next query.
export async function fedFetchWithDeadline(fedClient, peer, apiPath, opts, ms) {
  let timer;
  try {
    return await Promise.race([
      fedClient.fedFetch(peer, apiPath, opts),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms (dial included)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The wire form of the query: base64 of dim × float32 little-endian, which
// is exactly a discovery_tracks BLOB's bytes and exactly a Float32Array's
// (index entry.vec — a subarray view, hence byteOffset — or a centroid).
function vectorBase64(vec) {
  const v = Array.isArray(vec) ? Float32Array.from(vec) : vec;
  if (!(v instanceof Float32Array || v instanceof Uint8Array) || v.byteLength === 0) {
    throw new TypeError('query vector must be a Float32Array, an embedding BLOB or an array of numbers');
  }
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

/**
 * A throttled "this peer answered" writer: stamps federation_peers
 * last_status 'ok' + last_seen (updateFederationPeerStatus) at most once per
 * peer per `intervalMs`. Failures are never written — a 4 s deadline missed
 * by a peer still dialing is not proof the peer is down, and last_status is
 * what the admin UI shows as the peer's health; only the admin's own
 * test-connection (federation-client testPeer) records a failure.
 * Usable as fanOutFederation's `onPeerStatus`. Returns whether it wrote.
 */
export function createPeerStatusRecorder(write, { intervalMs = STATUS_WRITE_INTERVAL_MS } = {}) {
  const lastWrite = new Map();   // peer id → ms of the last write
  return function recordPeerStatus(peer, { reachable } = {}, now = Date.now()) {
    if (!reachable) { return false; }
    const last = lastWrite.get(peer.id);
    if (last !== undefined && now - last < intervalMs) { return false; }
    write(peer.id);
    lastWrite.set(peer.id, now);   // after the write: a failed write retries next answer
    return true;
  };
}

export const recordPeerStatus = createPeerStatusRecorder(
  (id) => fedDb.updateFederationPeerStatus(id, 'ok'));

/**
 * In-memory record of peers that keep missing their deadline, keyed by peer
 * id. miss() counts a transport failure; from the `missesBeforeCooldown`th
 * miss in a row on, the peer is parked for retryAfterMs × 2^(misses −
 * threshold), capped at maxRetryMs, and returns that duration (0 while under
 * the threshold). Misses keep counting across cool-downs until an answer, so
 * a dead peer costs one probe per cool-down: 60 s, 2 min, 4, 8, then
 * every 10 min. answered() and forget() clear the entry. Nothing is written to
 * federation_peers: see createPeerStatusRecorder for why a missed deadline
 * is no failure status.
 */
export function createPeerFailureMemory({
  retryAfterMs = PEER_RETRY_AFTER_MS,
  maxRetryMs = PEER_RETRY_MAX_MS,
  missesBeforeCooldown = PEER_MISSES_BEFORE_COOLDOWN,
} = {}) {
  const entries = new Map();   // peer id → { misses, until }
  const clear = (peerId) => { entries.delete(peerId); };
  return {
    coolingDown(peerId, now = Date.now()) {
      const e = entries.get(peerId);
      return e !== undefined && now < e.until;
    },
    miss(peerId, now = Date.now()) {
      const e = entries.get(peerId) || { misses: 0, until: 0 };
      e.misses += 1;
      entries.set(peerId, e);
      if (e.misses < missesBeforeCooldown) { return 0; }
      const ms = Math.min(retryAfterMs * 2 ** (e.misses - missesBeforeCooldown), maxRetryMs);
      e.until = now + ms;
      return ms;
    },
    answered: clear,
    // The admin seam: a successful test-connection, or the peer's removal.
    forget: clear,
  };
}

export const peerFailures = createPeerFailureMemory();

/**
 * The dial step of a fan-out, without its I/O: `dial(peer)` reaches the peer
 * (a throw is a TRANSPORT failure — deadline, dial error — and counts as a
 * miss, unless it carries `notAMiss`: this server could not dial at all, so
 * the memory is left as it was), `read(peer, response)` turns its answer
 * into the outcome value (a throw — a non-OK status such as a peer's 403,
 * bad JSON, an answer compressed or over the size cap — still rejects, but
 * the peer answered, so it clears the peer's misses). A peer in its
 * cool-down is not dialed: its outcome rejects at once, with
 * `reason.coolingDown` set. `forced` dials every peer regardless (a call
 * that names one peer on purpose). A miss that parks the peer rejects with
 * `reason.parkedMs` set. Resolves to Promise.allSettled outcomes in `peers`
 * order — what mergePeerAnswers takes.
 */
export async function settlePeers(peers, { dial, read, failures = peerFailures, now = Date.now, forced = false }) {
  const outcomes = await Promise.allSettled(peers.map(async (peer) => {
    if (!forced && failures.coolingDown(peer.id, now())) {
      throw Object.assign(new Error('not dialed: in its cool-down after failed dials'), { coolingDown: true });
    }
    let response;
    try {
      response = await dial(peer);
    } catch (err) {
      if (err?.notAMiss) { throw err; }
      const parkedMs = failures.miss(peer.id, now());
      if (parkedMs === 0) { throw err; }
      // A fresh error, not the dial's: a dial in progress is shared by
      // concurrent fan-outs (federation-client getPeerBridge), and so is
      // its rejection.
      throw Object.assign(new Error(err?.message ?? String(err), { cause: err }), { parkedMs });
    }
    try {
      return await read(peer, response);
    } finally {
      failures.answered(peer.id);
    }
  }));
  return outcomes;
}

/**
 * fanOutFederation's read step (settlePeers `read`): a peer's answer as
 * { body, at }, its body read to at most `maxBytes`. An answer sent
 * compressed (a Content-Encoding other than identity) is refused before a
 * byte is read: the fan-out asks for it uncompressed, which every mStream
 * honours (util/compression.js), and the cap counts bytes as handed over,
 * which a runtime may have inflated far past it first (Bun's fetch does,
 * unless told decompress: false). A content-length over the cap is refused
 * before a byte is read too; an answer without one (chunked) is read until
 * it crosses the cap, then cancelled. Each throws, like a non-OK status or
 * bad JSON: the peer contributes nothing and counts unreachable in this
 * call, and the fan-out logs it with the call's other failures. It is NO
 * miss — the peer answered, so settlePeers clears its misses and never
 * parks it: a peer that answers too much is up, and what it sends depends
 * on the query, so a cool-down would only hide a server the next call may
 * hear from.
 */
export async function readPeerAnswer(_peer, r, maxBytes = PEER_ANSWER_MAX_BYTES) {
  if (!r.ok) { throw new Error(`http ${r.status}`); }
  const encoding = (r.headers.get('content-encoding') || 'identity').trim().toLowerCase();
  if (encoding !== 'identity') {
    r.body?.cancel().catch(() => {});
    throw new Error(`answer sent with content-encoding '${encoding}', asked for uncompressed`);
  }
  const declared = Number(r.headers.get('content-length'));
  if (declared > maxBytes) {
    r.body?.cancel().catch(() => {});
    throw new Error(`answer of ${declared} bytes is over the ${maxBytes}-byte cap`);
  }
  const chunks = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      size += value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`answer over the ${maxBytes}-byte cap (stopped reading at ${size} bytes)`);
      }
      chunks.push(value);
    }
  }
  return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), at: Date.now() };
}

// A peer's album-art name, kept only when it is what the peer's
// /album-art/:file can serve: sanitizeFilename's own pattern
// (src/util/validation.js), which every cached cover matches (an md5 hash
// plus its extension, album-art.js). Matched raw, with no decoding, so no
// '%', '?', '#', dot segment, space or non-ASCII character ever reaches a
// client. A peer is untrusted, and a client splices this into a proxy URL.
const ART_NAME = /^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9]{1,7}$/;
export function peerArtName(v) {
  return typeof v === 'string' && ART_NAME.test(v) ? v : null;
}

// A peer's plain text field (albumArtist): a string of at most `max`
// characters once trimmed — the recommendation schema's own text(512)
// bound — else null. A peer is untrusted, and a client forwards the row.
export function peerText(v, max = 512) {
  if (typeof v !== 'string') { return null; }
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

// A peer's other text fields (artist, title, album, the IDs, filepath),
// trimmed, for the recommendation schema to judge: its text() trims before
// it checks max(), and repairRecommendation hands on the row as given, so a
// value padded with whitespace would pass at any length. Anything that is
// no string as sent: the schema refuses it (a number for an artist drops
// the row).
const peerString = (v) => (typeof v === 'string' ? v.trim() : v);

// A peer's number fields (year, duration): a number as sent, for the schema
// to judge, else null. The responder sends numbers; a numeric string would
// pass the schema's conversion and ride along as sent, padded or zero-filled
// to any length.
const peerNumber = (v) => (typeof v === 'number' ? v : null);

// A peer's similarity: the merge sorts on it and the novelty chain's
// near-duplicate check reads it, so it is a finite number, clamped to a
// cosine's [-1, 1] (a rounding step past either end is still a score), else
// null and the row is dropped. A string or NaN would sort in no consistent
// order and slip past the near-duplicate check.
export function peerSimilarity(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) { return null; }
  return Math.min(1, Math.max(-1, v));
}

// A peer's genreTags: its model's style names (the top five, as
// 'Electronic---Techno'; the longest Discogs name is 43 characters), kept as
// at most PEER_TAGS_MAX plain strings of at most PEER_TAG_MAX characters
// (peerText; anything else in the list is left out), else null. A value that
// is no array (a string, an object) is null too: the documented shape.
const PEER_TAGS_MAX = 10;
const PEER_TAG_MAX = 64;
export function peerTags(v) {
  if (!Array.isArray(v)) { return null; }
  const tags = [];
  for (const t of v) {
    if (tags.length >= PEER_TAGS_MAX) { break; }
    const tag = peerText(t, PEER_TAG_MAX);
    if (tag) { tags.push(tag); }
  }
  return tags.length ? tags : null;
}

/**
 * Pure merge of the peers' answers — no I/O, so it is unit-tested with
 * handcrafted answers. `answers[i]` is peers[i]'s Promise.allSettled outcome,
 * fulfilled with { body, at } (the peer's JSON and when it arrived).
 *
 * Every peer gets an entry, in `peers` order, whatever happened to it.
 * A peer's rows are untrusted, and both routes hand them to clients that
 * forward them to the plug-in routes: only its first PEER_LIMIT_CAP rows
 * are looked at (more than it was ever asked for — a 1 MB answer holds
 * some 20k minimal rows, each a schema check below, on every open), a row
 * without a numeric similarity is dropped (peerSimilarity), genreTags is
 * bounded (peerTags), its text trimmed (peerString) and its numbers kept
 * numbers (peerNumber), and the row is made one the recommendation schema
 * takes (repairRecommendation, as the Discover page's sendableRow does: a
 * bad optional fact nulled, a row the schema refuses in what it is
 * dropped) — before the dedupe, so a dropped row never claims a song
 * another peer could show.
 * Novel rows from every answering peer are ranked together (similarity desc;
 * ties keep peer order, then the peer's own order), and the cross-peer
 * dedupe walks that ranking: two peers holding the same song surface it
 * once, under the peer where it ranks highest. Each peer's list holds at
 * most `limit` rows; a row that finds its peer's list full does not claim
 * its song, so another peer that holds it can still show it.
 *
 * `results` is that walk as one list. Its first `limit` rows are exactly the
 * per-song route's answer: no peer's list can fill before `limit` rows were
 * accepted in total, so up to there the walk is the old single-cap walk.
 *
 * `moods`, when the peers were asked with a mood filter: a peer whose answer
 * does not echo one (older than the filter, or with no scores to filter by)
 * answered unfiltered, so its rows are dropped and its entry says
 * `moodsUnsupported: true` (counted in searched.moodsUnsupported). Both
 * keys exist only on a filtered call.
 */
export function mergePeerAnswers(peers, answers, { excludeSets, newArtistsOnly = false, limit = DEFAULT_LIMIT, moods = null }) {
  const searched = { peers: 0, unreachable: 0, mismatched: 0, ...(moods && { moodsUnsupported: 0 }) };
  const groups = [];
  const merged = [];   // { group, row }
  for (const [i, peer] of peers.entries()) {
    const outcome = answers[i];
    const group = {
      id: peer.id,
      name: peer.name,
      // When this call heard from it, else the stored last_seen (stale: only
      // the admin's tests and recordPeerStatus write it).
      lastSeen: toIso(peer.last_seen),
      reachable: false,
      mismatched: false,
      results: [],
    };
    groups.push(group);
    if (!outcome || outcome.status !== 'fulfilled') { searched.unreachable += 1; continue; }
    group.reachable = true;
    if (Number.isFinite(outcome.value?.at)) { group.lastSeen = new Date(outcome.value.at).toISOString(); }
    // A peer is untrusted: a body that isn't the documented object answers
    // nothing rather than throwing the whole fan-out away.
    const body = outcome.value?.body || {};
    if (body.modelMismatch) { group.mismatched = true; searched.mismatched += 1; continue; }
    if (moods && !(body.moods && typeof body.moods === 'object')) {
      group.moodsUnsupported = true;
      searched.moodsUnsupported += 1;
      continue;
    }
    searched.peers += 1;
    for (const r of Array.isArray(body.results) ? body.results.slice(0, PEER_LIMIT_CAP) : []) {
      if (!r || typeof r !== 'object') { continue; }
      const similarity = peerSimilarity(r.similarity);
      if (similarity === null) { continue; }
      const recordingMbid = peerString(r.recordingMbid);
      if (!isNovel(excludeSets, {
        artist: r.artist,
        title: r.title,
        recordingMbid,
        similarityVsSeed: similarity,
      }, { newArtistsOnly })) { continue; }
      const { row, nulled, error } = repairRecommendation({
        artist: peerString(r.artist),
        title: peerString(r.title),
        // Catalogue fields — absent (null) from peers older than the
        // discovery.db V3 responder; every field here is optional.
        album: peerString(r.album) ?? null,
        // The album's own credit (a compilation's "Various Artists"),
        // apart from the track's artist: an album copy lists the album by
        // it, whole. Null from peers before 2026-10-19 (peerText).
        albumArtist: peerText(r.albumArtist),
        year: peerNumber(r.year),
        isrc: peerString(r.isrc) ?? null,
        releaseGroupMbid: peerString(r.releaseGroupMbid) ?? null,
        // The track's cover on the PEER (its /album-art/<name> file),
        // fetched through this server's art proxy
        // (/api/v1/federation/peers/:id/art/<name>). Null from older
        // peers and for anything that is not one plain file name.
        albumArt: peerArtName(r.albumArt),
        duration: peerNumber(r.duration),
        similarity,
        genreTags: peerTags(r.genreTags),
        recordingMbid,
        // filepath is the PEER's vpath-form path — what the federation
        // stream proxy plays, and provenance the panel can show.
        filepath: peerString(r.filepath),
        peer: { id: peer.id, name: peer.name },
      });
      if (!row) {
        winston.debug(`discovery federation: dropped a row from peer id=${peer.id} that is not a valid recommendation: ${error}`);
        continue;
      }
      if (nulled.length) {
        winston.debug(`discovery federation: nulled ${nulled.join(', ')} on a row from peer id=${peer.id}: ${error}`);
      }
      merged.push({ group, row });
    }
  }

  // Cross-peer dedupe: two peers holding the same song should surface it
  // once (highest similarity wins — walk in sorted order). Keyed by MBID
  // when present AND normalized artist+title, so a tagged copy on one
  // peer dedupes an untagged copy on another whenever the names agree.
  merged.sort((a, b) => b.row.similarity - a.row.similarity);
  const seen = new Set();
  const results = [];
  for (const { group, row } of merged) {
    if (group.results.length >= limit) { continue; }
    const keys = [`a:${norm(row.artist)} ${norm(row.title)}`];
    if (row.recordingMbid) { keys.push(`m:${row.recordingMbid}`); }
    if (keys.some((k) => seen.has(k))) { continue; }
    for (const k of keys) { seen.add(k); }
    group.results.push(row);
    results.push(row);
  }
  return { peers: groups, searched, results };
}

// The federation client, loaded once. Exported so the Discover page can
// load it BEFORE it starts a fan-out: on the first call in a process the
// import is real I/O, and a fan-out that awaited it inside would only dial
// after the page's synchronous library pass.
export async function loadFederationClient() {
  if (!fedClientModule) { fedClientModule = await import('../state/federation-client.js'); }
  return fedClientModule;
}

/**
 * Ask the paired servers (federation_peers with use_discovery on) for songs
 * like `vec`, keeping each peer's outcome.
 *
 *   vec             unit vector — Float32Array (index entry.vec, a centroid)
 *                   or a discovery_tracks embedding BLOB; sent as-is
 *   modelId         the vector's model space (a peer in another answers
 *                   modelMismatch)
 *   peerId          ask that one peer only; 404 when it is unknown or has
 *                   use_discovery off
 *   limit           rows per peer (and the per-song route's total cap)
 *   newArtistsOnly  also drop artists the local library already has
 *   headroom        each peer is asked for limit × headroom rows (default 3,
 *                   capped at the peer route's 100) — the novelty chain and
 *                   dedupe run after it answers
 *   onPeerStatus    optional (peer row, { reachable, mismatched }) callback,
 *                   once per peer after the fan-out settles; pass
 *                   recordPeerStatus to refresh last_seen (throttled)
 *   moods           optional mood filter (api/mood-filter.js, normalized).
 *                   It rides in the `moods` query parameter, not the body:
 *                   the peer route's body schema is strict, and a peer
 *                   older than the filter ignores a query string — then
 *                   answers unfiltered, without the echo that
 *                   mergePeerAnswers keeps a peer's rows on
 *   failures, now, fedClient
 *                   the miss memory, clock and federation client (tests
 *                   inject; default the module's peerFailures, Date.now and
 *                   state/federation-client.js)
 *
 * Resolves to { peers: [{ id, name, lastSeen, reachable, mismatched,
 * results }], searched: { peers, unreachable, mismatched }, results } — see
 * mergePeerAnswers. Each peer costs at most PEER_TIMEOUT_MS, dial included,
 * and PEER_ANSWER_MAX_BYTES read, uncompressed (readPeerAnswer), and nothing
 * while in its cool-down (settlePeers; with peerId it is dialed anyway); an
 * unreachable peer is an outcome, never an error.
 */
export async function fanOutFederation(vec, modelId, {
  peerId, limit = DEFAULT_LIMIT, newArtistsOnly = false, headroom = HEADROOM, onPeerStatus, moods = null,
  failures = peerFailures, now = Date.now, fedClient: givenClient,
} = {}) {
  let peers = fedDb.getFederationPeers().filter((p) => p.use_discovery === 1);
  if (peerId !== undefined) {
    peers = peers.filter((p) => p.id === peerId);
    if (peers.length === 0) { throw new WebError('Peer not found or not searchable', 404); }
  }
  if (peers.length === 0) {
    return { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 }, results: [] };
  }

  const payload = JSON.stringify({
    embedding: vectorBase64(vec),
    modelId,
    // An integer within the peer route's Joi bounds, or the peer 400s.
    limit: Math.max(1, Math.min(PEER_LIMIT_CAP, Math.ceil(limit * headroom))),
  });
  const similarPath = '/api/v1/federation/discovery/similar'
    + (moods ? `?moods=${encodeURIComponent(JSON.stringify(moods))}` : '');

  // Loaded lazily like the admin routes do — federation-client pulls in
  // the iroh machinery, which stays cold until a peer is actually dialed.
  // Kept once loaded: an `await import()` defers even a cached module to a
  // later job, and the Discover page starts this fan-out BEFORE its
  // synchronous library pass precisely so the peer requests are already
  // on their way (it awaits them last).
  const fedClient = givenClient || fedClientModule || await loadFederationClient();
  const answers = await settlePeers(peers, {
    dial: async (peer) => {
      try {
        return await fedFetchWithDeadline(fedClient, peer, similarPath, {
          method: 'POST',
          // Uncompressed, so PEER_ANSWER_MAX_BYTES bounds what is inflated
          // and not only what is parsed: every mStream answers identity
          // when asked (util/compression.js), and decompress: false keeps
          // Bun's fetch from inflating an answer that comes compressed
          // anyway before readPeerAnswer refuses it (Node's fetch ignores
          // the option, and inflates only what is read).
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
          decompress: false,
          body: payload,
          // Still useful: bounds the response-body read once headers arrive.
          signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        }, PEER_TIMEOUT_MS);
      } catch (err) {
        // THIS server's endpoint is down: at boot it binds after the
        // remote-access tunnel's start (an online wait of up to 8 s, with
        // HTTP already serving), a reboot stops it, and enabling federation
        // starts it after the flag flips. connectToPeer then throws at once
        // and the peer was never asked — counting that would park every
        // peer on the first two opens. A fresh error: a shared in-flight
        // dial's rejection is not ours to tag.
        if (getEndpointId() === null) {
          throw Object.assign(new Error(err?.message ?? String(err), { cause: err }), { notAMiss: true });
        }
        throw err;
      }
    },
    read: readPeerAnswer,
    failures,
    now,
    // "More like this on <peer>" names that peer on purpose: always dialed.
    forced: peerId !== undefined,
  });

  for (const [i, outcome] of answers.entries()) {
    if (outcome.status !== 'rejected') { continue; }
    const peer = peers[i];
    const why = outcome.reason;
    // One dead peer must not warn on every open: only its probes do.
    if (why?.coolingDown) {
      winston.debug(`discovery federation similar: peer '${peer.name}' (id=${peer.id}) skipped: ${why.message}`);
      continue;
    }
    const parked = why?.parkedMs > 0 ? `, not asked again for ${Math.round(why.parkedMs / 1000)} s` : '';
    winston.warn(`discovery federation similar: peer '${peer.name}' (id=${peer.id}) failed: ${why?.message}${parked}`);
  }

  const out = mergePeerAnswers(peers, answers, {
    excludeSets: localIdentitySets(), newArtistsOnly, limit, moods,
  });

  if (typeof onPeerStatus === 'function') {
    for (const [i, peer] of peers.entries()) {
      const { reachable, mismatched } = out.peers[i];
      // Bookkeeping must never cost the user their results.
      try { onPeerStatus(peer, { reachable, mismatched }); } catch (err) {
        winston.warn(`discovery federation: status update for peer id=${peer.id} failed: ${err.message}`);
      }
    }
  }
  return out;
}

export function setup(mstream) {
  // Similar-but-not-owned tracks across the federated peers.
  //   filePath        the local seed track ("<vpath>/<relpath>")
  //   limit           max results (default 10, cap 50)
  //   newArtistsOnly  also drop artists the local library already has
  //   peerId          ask ONE paired server only (the recommendation
  //                   modal's "more like this on <peer>"); 404 when that
  //                   peer is unknown or has opted out of discovery
  mstream.post('/api/v1/discovery/federation/similar', async (req, res) => {
    if (config.program.federation.enabled !== true) {
      throw new WebError('federation is disabled (config: federation.enabled)', 403);
    }
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      newArtistsOnly: Joi.boolean().default(false),
      peerId: Joi.number().integer().min(1).optional(),
    });
    const { value: { filePath, limit, newArtistsOnly, peerId } } = joiValidate(schema, req.body);

    // Same resolution + uniform-404 + probe logging as the local/p2p routes.
    const seedRow = resolveSeedTrack(req, filePath, 'discovery/federation/similar');
    const canonHash = seedRow.audio_hash || seedRow.file_hash;

    if (!discoveryDb.openDiscoveryDbIfExists()) {
      throw new WebError('discovery data collection has never been enabled — no embeddings to search with', 404);
    }
    const seed = discoveryDb.getDiscoveryDb().prepare(`
      SELECT embedding, model_id FROM discovery_tracks WHERE audio_hash = ?
    `).get(canonHash);
    if (!seed || !seed.embedding) {
      throw new WebError('track has no embedding yet — the analysis pass has not processed it', 404);
    }

    const query = { filePath, modelId: seed.model_id, newArtistsOnly };
    if (peerId !== undefined) { query.peerId = peerId; }
    // No status write here: this route answers on every song change, and
    // the throttled refresh is the Discover page's (recordPeerStatus).
    const { searched, results } = await fanOutFederation(seed.embedding, seed.model_id, {
      peerId, limit, newArtistsOnly,
    });
    // One ranked list across peers, capped at `limit` in total.
    res.json({ query, searched, results: results.slice(0, limit) });
  });
}
