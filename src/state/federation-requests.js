// The federation-requests engine: in-network pairing over the discovery
// DM transport. One state machine serving both roles — requester and
// recipient — persisted in federation_requests (SCHEMA_V67, accessors in
// db/federation-requests.js).
//
//   A (requester)                                B (recipient)
//     compose() ── dm federation-request ──────▶ inbox row (opt-in gate)
//                                                accept() mints a key
//     ◀────────── dm federation-accept {ticket} ──
//     addFederationPeer(B) + testPeer            (A now reads B)
//     if A offered: mint ── dm federation-grant {ticket} ──▶ addFederationPeer(A)
//
// SECURITY INVARIANT: no credential ever travels in the request itself —
// tickets only flow AFTER an explicit accept, so a rejected (or ignored)
// recipient never holds anything. Sender identity on every inbound DM is
// the QUIC-authenticated endpoint id from the sidecar; handlers only act
// on a uuid when the sender matches the row's peer. peer_name/message are
// self-asserted, size-capped, control-stripped — and still untrusted.
//
// Delivery semantics ride sendDm's three outcomes (see discovery-p2p.js):
// resolved-delivered advances the row; resolved-refused is terminal for a
// cold request ('refused' — the plan's "inbox off gets a typed refusal,
// not silence") but only transient for accept/grant (the peer ASKED for
// this pairing — a momentarily-off inbox shouldn't strand a half-built
// one); rejection (unreachable) walks the retry ladder. Retries are keyed
// off next_attempt_at and swept every SWEEP_MS; a peer's catalog
// announcement pulls its due times forward, so "peer came online" retries
// happen at announce cadence instead of a six-hour rung.
//
// All handlers are idempotent by uuid: a re-delivered accept re-acks at
// the transport and no-ops here; nothing double-mints or double-adds.

import crypto from 'crypto';
import winston from 'winston';
import * as config from './config.js';
import * as reqDb from '../db/federation-requests.js';
import * as fedDb from '../db/federation.js';
import * as db from '../db/manager.js';
import * as p2p from './discovery-p2p.js';

export const REQUEST_TTL_SECONDS = 14 * 24 * 3600;
// Retry ladder for owed DMs (seconds): 1m → 5m → 30m → 6h, then 6h forever
// until the TTL ends it. Index = min(fail_count - 1, last).
const BACKOFF_SECONDS = [60, 300, 1800, 21600];
const SWEEP_MS = 60 * 1000;
const INBOX_CAP = 50;
const TOMBSTONE_DAYS = 7;
// Inbound string caps — transport already caps the envelope at 8 KB; these
// keep single fields honest. Mirror the compose-side Joi in the routes.
const CAP = { name: 64, message: 500, reason: 200, offerItems: 32, offerName: 64 };

const sanitize = (v, max) => {
  if (typeof v !== 'string') { return null; }
  const clean = v.replace(/[\p{Cc}]/gu, '').trim();
  return clean ? clean.slice(0, max) : null;
};
const validUuid = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

// ── Wiring ──────────────────────────────────────────────────────────────────

let subscribed = false;
let sweepTimer = null;
const inFlight = new Set(); // row ids with an attempt currently running

// Idempotent; called from the discovery stack start (which also replays on
// crash recovery — same contract as discovery-catalog.subscribe()).
export function subscribe() {
  if (subscribed) { return; }
  subscribed = true;
  p2p.events.on('dm', (msg) => {
    handleInbound(msg).catch((err) => {
      winston.warn(`[federation-requests] inbound dm handler failed: ${err.message}`);
    });
  });
  // Presence signal: a peer announcing on the catalog topic is reachable
  // right now — pull any DMs we owe it forward and try immediately.
  p2p.events.on('announcement', (msg) => {
    try {
      if (reqDb.markPeerAttemptsDue(msg.from) > 0) {
        winston.info(`[federation-requests] peer ${msg.from.slice(0, 12)}… is online — retrying owed messages`);
        runSweep().catch((err) => winston.warn(`[federation-requests] presence-kicked sweep failed: ${err.message}`));
      }
    } catch (err) {
      winston.warn(`[federation-requests] presence kick failed: ${err.message}`);
    }
  });
  sweepTimer = setInterval(() => {
    runSweep().catch((err) => winston.warn(`[federation-requests] sweep failed: ${err.message}`));
  }, SWEEP_MS);
  if (sweepTimer.unref) { sweepTimer.unref(); }
}

// Push the DM-accept policy down to the sidecar's fail-closed flag. The
// transport must accept in TWO situations: the operator opened the inbox
// (acceptRequests), OR any exchange is still live — a requester with its
// inbox off still has to receive the accept/grant/reject replies to its
// own outbound requests (verb-level gating in handleInbound keeps NEW
// requests out either way). Called at stack start, from the live admin
// toggle, after compose/cancel, and once per sweep — so the window closes
// within a sweep of the last exchange ending. Lenient offline (the
// sidecar boots refusing, and the flag is re-pushed on every start).
export async function pushAcceptPolicy() {
  const accept = config.program.federation.acceptRequests === true || reqDb.hasActiveRequests();
  try {
    await p2p.setDmAccept(accept);
  } catch (err) {
    winston.warn(`[federation-requests] setDmAccept(${accept}) failed — inbox stays closed at the transport: ${err.message}`);
  }
}

// ── Outbound: compose / cancel ──────────────────────────────────────────────

// Queue a federation request to a discovery peer and attempt delivery
// immediately. offeredLibraries = OUR library names to grant back on
// accept (may be empty = one-way ask). Throws plain Errors; the admin
// route maps them onto status codes.
export async function compose({ peerEndpointId, message = null, offeredLibraries = [] }) {
  // Import before the guards: the stretch from the one-active-request check
  // down to createRequest must stay synchronous, or two racing composes (a
  // double-click) could both pass the guard and queue duplicate rows.
  const catalog = await import('./discovery-catalog.js');
  if (config.program.discoveryP2p.enabled !== true) { throw new Error('the discovery network is not enabled'); }
  if (config.program.federation.enabled !== true) { throw new Error('federation is not enabled'); }
  if (config.program.discoveryP2p.blockedPeers.includes(peerEndpointId)) {
    throw new Error('this peer is blocked');
  }
  const existing = reqDb.listRequests().find((r) => r.direction === 'out'
    && r.peer_endpoint_id === peerEndpointId && reqDb.ACTIVE_STATES.includes(r.state));
  if (existing) { throw new Error(`a request to this peer is already ${existing.state}`); }

  const peerName = catalog.get(peerEndpointId)?.payload?.name || null;
  const row = reqDb.createRequest({
    uuid: crypto.randomUUID(),
    direction: 'out',
    peerEndpointId,
    peerName,
    message: sanitize(message, CAP.message),
    offeredLibraries,
    state: 'pending-delivery',
    ttlSeconds: REQUEST_TTL_SECONDS,
    nextAttemptInSeconds: 0,
  });
  winston.info(`[federation-requests] ${row.uuid} composed for peer ${peerEndpointId.slice(0, 12)}… `
    + `(offering ${offeredLibraries.length ? offeredLibraries.join(', ') : 'nothing'})`);
  // Open our own transport window so the accept/reject reply can land even
  // when the operator's inbox is otherwise off.
  await pushAcceptPolicy();
  attempt(row.id).catch((err) => winston.warn(`[federation-requests] first delivery attempt failed: ${err.message}`));
  return reqDb.getRequestById(row.id);
}

// Withdraw an outbound request. The courtesy DM is best-effort and only
// worth sending when the peer actually saw the request.
export function cancel(id) {
  const row = reqDb.getRequestById(id);
  if (!row || row.direction !== 'out') { throw new Error('Request not found'); }
  if (!['pending-delivery', 'delivered'].includes(row.state)) {
    throw new Error(`cannot cancel a request in state '${row.state}'`);
  }
  reqDb.updateRequest(id, { state: 'cancelled', nextAttemptInSeconds: null });
  winston.info(`[federation-requests] ${row.uuid} cancelled by the operator`);
  if (row.state === 'delivered') {
    sendCourtesy(row, { type: 'federation-withdraw', uuid: row.uuid });
  }
  return reqDb.getRequestById(id);
}

// ── Recipient actions: accept / reject ──────────────────────────────────────

// Accept an inbox request: mint the key (the route resolved names → ids
// and the limit fields already), then owe the peer a federation-accept DM
// carrying the swap-ready ticket. acceptTheirOffer records whether we
// expect their grant-back after our accept lands.
export async function accept(id, { libraryIds, vpathNames, limits, expiresAt = null, acceptTheirOffer = true }) {
  // Import first: the read→check→mint→update stretch below is synchronous,
  // so two racing accepts (an operator double-click) cannot both pass the
  // state check and double-mint — the loser reads 'accepted' and throws.
  // reject() and cancel() get the same guarantee free by having no awaits.
  const federation = await import('./federation.js');
  const row = reqDb.getRequestById(id);
  if (!row || row.direction !== 'in') { throw new Error('Request not found'); }
  if (row.state !== 'received') { throw new Error(`cannot accept a request in state '${row.state}'`); }
  if (config.program.discoveryP2p.blockedPeers.includes(row.peer_endpoint_id)) {
    throw new Error('this peer is blocked'); // blocked after the request landed
  }
  if (config.program.federation.enabled !== true) { throw new Error('federation is not enabled'); }
  if (!federation.getEndpointTicket()) { throw new Error('the federation endpoint is not running'); }

  const keyName = `request: ${row.peer_name || row.peer_endpoint_id.slice(0, 12)}`.slice(0, 64);
  const minted = fedDb.createFederationKey(keyName, libraryIds, limits, expiresAt);
  reqDb.updateRequest(id, {
    state: 'accepted',
    mintedKeyId: minted.id,
    acceptTheirOffer: acceptTheirOffer && row.offered_libraries.length > 0,
    nextAttemptInSeconds: 0,
    failCount: 0,
  });
  winston.info(`[federation-requests] ${row.uuid} accepted — minted key '${keyName}' `
    + `for [${vpathNames.join(', ')}]; sending the ticket`);
  attempt(id).catch((err) => winston.warn(`[federation-requests] accept delivery attempt failed: ${err.message}`));
  return reqDb.getRequestById(id);
}

export function reject(id, reason = null) {
  const row = reqDb.getRequestById(id);
  if (!row || row.direction !== 'in') { throw new Error('Request not found'); }
  if (row.state !== 'received') { throw new Error(`cannot reject a request in state '${row.state}'`); }
  const clean = sanitize(reason, CAP.reason);
  reqDb.updateRequest(id, { state: 'rejected', rejectReason: clean, nextAttemptInSeconds: null });
  winston.info(`[federation-requests] ${row.uuid} rejected${clean ? ` (${clean})` : ''} — `
    + `peer ${row.peer_endpoint_id.slice(0, 12)}… tombstoned for ${TOMBSTONE_DAYS} days`);
  sendCourtesy(row, { type: 'federation-reject', uuid: row.uuid, ...(clean ? { reason: clean } : {}) });
  return reqDb.getRequestById(id);
}

// ── Delivery: the owed-DM attempt loop ──────────────────────────────────────

// Build the swap-ready mstrfed1: ticket for a minted key. Throws when the
// endpoint isn't up yet — the caller treats that like any transport
// failure and retries.
async function ticketForMintedKey(keyId) {
  const federation = await import('./federation.js');
  const endpointTicket = federation.getEndpointTicket();
  if (!endpointTicket) { throw new Error('federation endpoint not running'); }
  const keyRow = fedDb.getFederationKeyById(keyId);
  if (!keyRow) { throw new Error('minted key vanished (revoked?)'); }
  const os = await import('os');
  return federation.buildFederationTicket({
    endpointTicket,
    key: keyRow.key,
    serverName: config.program.federation.serverName || os.hostname(),
    libraries: fedDb.getFederationKeyLibraries(keyId).map((l) => l.name),
    expiresAt: keyRow.expires_at ? `${keyRow.expires_at.replace(' ', 'T')}Z` : null,
  });
}

function payloadForRow(row) {
  if (row.direction === 'out' && row.state === 'pending-delivery') {
    return Promise.resolve({
      type: 'federation-request',
      uuid: row.uuid,
      name: config.program.discoveryP2p.serverName,
      offer: row.offered_libraries,
      ...(row.message ? { msg: row.message } : {}),
    });
  }
  if (row.direction === 'in' && row.state === 'accepted') {
    return (async () => ({
      type: 'federation-accept',
      uuid: row.uuid,
      ticket: await ticketForMintedKey(row.minted_key_id),
      wantOffer: row.accept_their_offer === 1,
    }))();
  }
  if (row.direction === 'out' && row.state === 'granting') {
    return (async () => ({
      type: 'federation-grant',
      uuid: row.uuid,
      ticket: await ticketForMintedKey(row.minted_key_id),
    }))();
  }
  return Promise.resolve(null); // state owes nothing — a stale sweep pick
}

function advanceAfterDelivery(row) {
  if (row.direction === 'out' && row.state === 'pending-delivery') {
    return { state: 'delivered', nextAttemptInSeconds: null, failCount: 0 };
  }
  if (row.direction === 'in' && row.state === 'accepted') {
    // Their grant is the next move (when we wanted their offer); nothing
    // more to send either way.
    const expectGrant = row.accept_their_offer === 1;
    return { state: expectGrant ? 'granting' : 'completed', nextAttemptInSeconds: null, failCount: 0 };
  }
  if (row.direction === 'out' && row.state === 'granting') {
    return { state: 'completed', nextAttemptInSeconds: null, failCount: 0 };
  }
  return null;
}

// One delivery attempt for whatever DM the row currently owes.
async function attempt(id) {
  if (inFlight.has(id)) { return; }
  inFlight.add(id);
  try {
    const row = reqDb.getRequestById(id);
    if (!row) { return; }
    const payload = await payloadForRow(row);
    if (!payload) { return; }

    let outcome;
    try {
      outcome = await p2p.sendDm(row.peer_endpoint_id, payload);
    } catch (err) {
      // Never reached (offline / pre-DM build / timeout): walk the ladder.
      const failCount = row.fail_count + 1;
      const delay = BACKOFF_SECONDS[Math.min(failCount - 1, BACKOFF_SECONDS.length - 1)];
      reqDb.updateRequest(id, { failCount, nextAttemptInSeconds: delay });
      winston.info(`[federation-requests] ${row.uuid} ${payload.type} undeliverable `
        + `(attempt ${failCount}: ${err.message}) — retrying in ${delay}s`);
      return;
    }

    if (outcome.delivered === true) {
      const patch = advanceAfterDelivery(row);
      if (patch) { reqDb.updateRequest(id, patch); }
      winston.info(`[federation-requests] ${row.uuid} ${payload.type} delivered to `
        + `${row.peer_endpoint_id.slice(0, 12)}… → ${patch ? patch.state : row.state}`);
      return;
    }

    // Reached and refused. A refused cold request is terminal by design
    // (the peer's typed "no"); rate limiting is always transient; and an
    // accept/grant refusal only means the peer's inbox is momentarily off —
    // they asked for this pairing, so keep trying until the TTL says stop.
    const transient = outcome.reason === 'rate-limited'
      || (payload.type !== 'federation-request' && outcome.reason === 'not-accepting');
    if (transient) {
      const failCount = row.fail_count + 1;
      const delay = BACKOFF_SECONDS[Math.min(failCount - 1, BACKOFF_SECONDS.length - 1)];
      reqDb.updateRequest(id, { failCount, nextAttemptInSeconds: delay });
      winston.info(`[federation-requests] ${row.uuid} ${payload.type} refused (${outcome.reason}) — retrying in ${delay}s`);
      return;
    }
    reqDb.updateRequest(id, {
      state: 'refused',
      rejectReason: `transport: ${outcome.reason}`,
      nextAttemptInSeconds: null,
    });
    revokeUndeliveredKey(row, `refused (${outcome.reason})`);
    winston.warn(`[federation-requests] ${row.uuid} ${payload.type} refused by `
      + `${row.peer_endpoint_id.slice(0, 12)}… (${outcome.reason}) — terminal`);
  } finally {
    inFlight.delete(id);
  }
}

// A minted key whose credential DM never confirmed delivery reaches nobody
// — revoke it rather than leave a live credential pointing at a dead
// exchange. (The lost-ack edge — peer got the ticket but our promise died
// — surfaces as their testPeer failing later, visibly and logged.)
function revokeUndeliveredKey(row, why) {
  if (!row.minted_key_id) { return; }
  if (!(row.direction === 'in' && row.state === 'accepted') && !(row.direction === 'out' && row.state === 'granting')) { return; }
  try {
    if (fedDb.deleteFederationKey(row.minted_key_id)) {
      winston.info(`[federation-requests] ${row.uuid} revoked undelivered key id=${row.minted_key_id} (${why})`);
    }
  } catch (err) {
    winston.warn(`[federation-requests] ${row.uuid} failed to revoke orphaned key id=${row.minted_key_id}: ${err.message}`);
  }
}

// Best-effort one-shot notification (reject / withdraw): no retry ladder,
// no state impact — an unreachable peer just finds out via its own TTL.
function sendCourtesy(row, payload) {
  p2p.sendDm(row.peer_endpoint_id, payload).then((r) => {
    if (r.delivered !== true) {
      winston.info(`[federation-requests] ${row.uuid} courtesy ${payload.type} refused (${r.reason})`);
    }
  }).catch((err) => {
    winston.info(`[federation-requests] ${row.uuid} courtesy ${payload.type} not delivered: ${err.message}`);
  });
}

// The periodic pass: expire the overdue, then retry whatever owed DM is
// due. Exported for tests (which drive it instead of waiting on the
// interval). TTL expiry runs even while the sidecar is down — it's pure
// bookkeeping; delivery attempts need the transport up.
export async function runSweep() {
  const { expired, orphanKeyIds } = reqDb.expireOverdueRequests();
  if (expired > 0) {
    winston.info(`[federation-requests] expired ${expired} request(s) past their ${REQUEST_TTL_SECONDS / 86400}-day TTL`);
    for (const keyId of orphanKeyIds) {
      try {
        if (fedDb.deleteFederationKey(keyId)) {
          winston.info(`[federation-requests] revoked undelivered key id=${keyId} (request expired)`);
        }
      } catch (err) {
        winston.warn(`[federation-requests] failed to revoke orphaned key id=${keyId}: ${err.message}`);
      }
    }
  }
  if (config.program.discoveryP2p.enabled !== true || !p2p.isRunning()) { return; }
  const due = reqDb.getDueRetries();
  await Promise.allSettled(due.map((row) => attempt(row.id)));
  // Re-derive the transport window: the last live exchange ending (or a
  // new one appearing via another path) changes what setDmAccept should be.
  await pushAcceptPolicy();
}

// ── Inbound DMs ─────────────────────────────────────────────────────────────

async function handleInbound({ from, payload }) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') { return; }
  if (!payload.type.startsWith('federation-')) { return; } // not ours
  // The inbox setting gates NEW requests only. Replies to our own
  // exchanges (accept/grant/reject/withdraw) pass regardless — the
  // transport was open for exactly their sake (see pushAcceptPolicy), and
  // rowForSender's uuid + sender match is their real auth.
  if (payload.type === 'federation-request' && config.program.federation.acceptRequests !== true) {
    winston.warn(`[federation-requests] dropped ${payload.type} from ${from.slice(0, 12)}… — the inbox is off`);
    return;
  }
  if (config.program.discoveryP2p.blockedPeers.includes(from)) {
    winston.warn(`[federation-requests] dropped ${payload.type} from blocked peer ${from.slice(0, 12)}…`);
    return;
  }
  if (!validUuid(payload.uuid)) {
    winston.warn(`[federation-requests] dropped ${payload.type} from ${from.slice(0, 12)}… — bad uuid`);
    return;
  }
  switch (payload.type) {
    case 'federation-request': handleRequest(from, payload); return;
    case 'federation-accept': await handleAccept(from, payload); return;
    case 'federation-grant': await handleGrant(from, payload); return;
    case 'federation-reject': handleReject(from, payload); return;
    case 'federation-withdraw': handleWithdraw(from, payload); return;
    default:
      winston.warn(`[federation-requests] dropped unknown verb '${payload.type}' from ${from.slice(0, 12)}…`);
  }
}

// A new request lands in the inbox — after every spam gate. All drops are
// silent to the sender by design (indistinguishable from "ignored", which
// TTLs out on their side) but always logged here.
function handleRequest(from, payload) {
  if (reqDb.getRequestByUuid(payload.uuid)) { return; } // idempotent re-delivery
  if (reqDb.recentlyRejectedPeer(from, TOMBSTONE_DAYS)) {
    winston.warn(`[federation-requests] dropped request from ${from.slice(0, 12)}… — rejected within ${TOMBSTONE_DAYS} days`);
    return;
  }
  if (reqDb.hasActiveFromPeer(from)) {
    winston.warn(`[federation-requests] dropped request from ${from.slice(0, 12)}… — one active request per peer`);
    return;
  }
  if (reqDb.countPendingInbound() >= INBOX_CAP) {
    winston.warn(`[federation-requests] dropped request from ${from.slice(0, 12)}… — inbox is full (${INBOX_CAP})`);
    return;
  }
  const offer = Array.isArray(payload.offer)
    ? payload.offer.slice(0, CAP.offerItems).map((n) => sanitize(n, CAP.offerName)).filter(Boolean)
    : [];
  const row = reqDb.createRequest({
    uuid: payload.uuid,
    direction: 'in',
    peerEndpointId: from,
    peerName: sanitize(payload.name, CAP.name),
    message: sanitize(payload.msg, CAP.message),
    offeredLibraries: offer,
    state: 'received',
    ttlSeconds: REQUEST_TTL_SECONDS,
  });
  winston.info(`[federation-requests] request ${row.uuid} received from `
    + `'${row.peer_name || 'unnamed'}' (${from.slice(0, 12)}…), offering `
    + `${offer.length ? offer.join(', ') : 'nothing'} — awaiting the operator`);
}

// Resolve a row by uuid ONLY when the sender is the row's peer — the QUIC
// identity is the auth here; anyone else probing uuids gets dropped+logged.
function rowForSender(from, uuid, direction, verb) {
  const row = reqDb.getRequestByUuid(uuid);
  if (!row || row.direction !== direction) {
    winston.warn(`[federation-requests] dropped ${verb} from ${from.slice(0, 12)}… — no matching request`);
    return null;
  }
  if (row.peer_endpoint_id !== from) {
    winston.warn(`[federation-requests] dropped ${verb} for ${uuid} — sender ${from.slice(0, 12)}… is not the peer on the row`);
    return null;
  }
  return row;
}

// The peer accepted our request: their ticket makes them our peer (we can
// read them), and if we offered libraries — and they said they want them —
// we now owe the grant-back.
async function handleAccept(from, payload) {
  let row = rowForSender(from, payload.uuid, 'out', 'accept');
  if (!row) { return; }
  if (['granting', 'completed'].includes(row.state)) { return; } // idempotent re-delivery
  if (!['pending-delivery', 'delivered'].includes(row.state)) {
    winston.warn(`[federation-requests] ${row.uuid} late accept ignored (state '${row.state}')`);
    return;
  }
  const peerId = await addPeerFromTicket(row, payload.ticket, 'accept');
  if (peerId === null) { return; }
  // addPeerFromTicket yielded: a rapid duplicate of this accept may have
  // advanced the row meanwhile — re-read so only one handler mints the
  // grant-back (everything from here to updateRequest is synchronous).
  row = reqDb.getRequestById(row.id);
  if (!row || !['pending-delivery', 'delivered'].includes(row.state)) { return; }

  const wantOffer = payload.wantOffer !== false;
  const grantNames = wantOffer ? row.offered_libraries : [];
  const libraryIds = grantNames
    .map((name) => {
      const lib = db.getLibraryByName(name);
      if (!lib) { winston.warn(`[federation-requests] ${row.uuid} offered library '${name}' no longer exists — skipping it`); }
      return lib ? lib.id : null;
    })
    .filter((x) => x !== null);

  if (libraryIds.length === 0) {
    reqDb.updateRequest(row.id, { state: 'completed', createdPeerId: peerId, nextAttemptInSeconds: null });
    winston.info(`[federation-requests] ${row.uuid} completed — paired with ${from.slice(0, 12)}… (no grant-back${wantOffer ? '' : ' — peer declined the offer'})`);
    return;
  }
  const keyName = `request: ${row.peer_name || from.slice(0, 12)}`.slice(0, 64);
  const limits = config.program.federation.limits;
  const minted = fedDb.createFederationKey(keyName, libraryIds, limits, null);
  reqDb.updateRequest(row.id, {
    state: 'granting',
    createdPeerId: peerId,
    mintedKeyId: minted.id,
    nextAttemptInSeconds: 0,
    failCount: 0,
  });
  winston.info(`[federation-requests] ${row.uuid} accepted by peer — minted grant-back key '${keyName}' `
    + `(config-default limits); sending the ticket`);
  attempt(row.id).catch((err) => winston.warn(`[federation-requests] grant delivery attempt failed: ${err.message}`));
}

// The requester's grant-back after our accept: their ticket makes them our
// peer too, and the exchange is complete.
async function handleGrant(from, payload) {
  const row = rowForSender(from, payload.uuid, 'in', 'grant');
  if (!row) { return; }
  if (row.state === 'completed') { return; } // idempotent re-delivery
  if (!['granting', 'accepted'].includes(row.state)) {
    winston.warn(`[federation-requests] ${row.uuid} unexpected grant ignored (state '${row.state}')`);
    return;
  }
  const peerId = await addPeerFromTicket(row, payload.ticket, 'grant');
  if (peerId === null) { return; }
  reqDb.updateRequest(row.id, { state: 'completed', createdPeerId: peerId, nextAttemptInSeconds: null });
  winston.info(`[federation-requests] ${row.uuid} completed — mutual pairing with ${from.slice(0, 12)}…`);
}

function handleReject(from, payload) {
  const row = rowForSender(from, payload.uuid, 'out', 'reject');
  if (!row) { return; }
  if (!['pending-delivery', 'delivered'].includes(row.state)) { return; }
  const reason = sanitize(payload.reason, CAP.reason);
  reqDb.updateRequest(row.id, { state: 'rejected', rejectReason: reason, nextAttemptInSeconds: null });
  winston.info(`[federation-requests] ${row.uuid} rejected by ${from.slice(0, 12)}…${reason ? ` (${reason})` : ''}`);
}

function handleWithdraw(from, payload) {
  const row = rowForSender(from, payload.uuid, 'in', 'withdraw');
  if (!row) { return; }
  if (row.state !== 'received') { return; }
  reqDb.updateRequest(row.id, { state: 'cancelled', nextAttemptInSeconds: null });
  winston.info(`[federation-requests] ${row.uuid} withdrawn by its sender`);
}

// Parse a received mstrfed1: ticket and add its issuer as a federation
// peer. Returns the peer id, an existing peer's id on a re-delivery
// (UNIQUE api_key), or null on garbage (logged; the row stays put so a
// corrected re-send can still land).
async function addPeerFromTicket(row, ticket, verb) {
  const federation = await import('./federation.js');
  let parsed;
  try {
    parsed = federation.parseFederationTicket(ticket);
  } catch (err) {
    winston.warn(`[federation-requests] ${row.uuid} ${verb} carried an unparseable ticket: ${err.message}`);
    return null;
  }
  let peer;
  try {
    peer = fedDb.addFederationPeer({
      name: row.peer_name || parsed.name || 'Federation request',
      endpointTicket: parsed.endpointTicket,
      apiKey: parsed.apiKey,
    });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      const existing = fedDb.getFederationPeers().find((p) => p.api_key === parsed.apiKey);
      if (existing) { return existing.id; }
    }
    winston.warn(`[federation-requests] ${row.uuid} failed to add peer from ${verb} ticket: ${err.message}`);
    return null;
  }
  winston.info(`[federation-requests] ${row.uuid} added peer '${peer.name}' (id=${peer.id}) from the ${verb} ticket`);
  (async () => {
    try {
      const client = await import('./federation-client.js');
      await client.testPeer(peer);
    } catch (err) {
      winston.warn(`[federation-requests] initial test-connect for peer '${peer.name}' failed: ${err.message}`);
    }
  })();
  return peer.id;
}
