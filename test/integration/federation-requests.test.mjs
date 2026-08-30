/**
 * The federation-requests engine over real iroh DMs: this process runs the
 * real stack — engine + discovery-p2p sidecar + federation endpoint + DB —
 * and a bare RawSidecar plays the remote peer, scripted by the test (it
 * has no engine, so every remote move is explicit and assertable).
 *
 * Covered end-to-end:
 *  - OUT happy path: compose → delivered → peer accepts (ticket) → we add
 *    the peer AND owe the grant-back → peer receives a REAL parseable
 *    grant ticket whose key exists here → completed;
 *  - accept re-delivery is idempotent (no second peer, no second key);
 *  - IN happy path: request lands (sanitized), operator accepts with
 *    custom limits → peer gets the accept ticket (limits on the minted
 *    key) → peer grants back → completed;
 *  - concurrent duplicate accepts — an operator double-click, or a peer
 *    double-sending its accept DM — mint exactly ONE key (the check→mint
 *    stretch must not yield between reading the row and advancing it);
 *  - reject sends the courtesy DM and tombstones the peer for 7 days
 *    (the next request from them is dropped without a row);
 *  - cancel sends the courtesy withdraw;
 *  - a transport-refused cold request goes terminal ('refused');
 *  - an unreachable peer walks the retry ladder instead of dying;
 *  - the inbox toggle gates NEW requests at the verb level while replies
 *    keep flowing (the open-for-replies transport window);
 *  - the crossing guard: compose refuses while the same peer has a live
 *    inbound request here (one exchange per relationship);
 *  - a withdraw crossing our accept revokes the unclaimed minted key
 *    (which nothing else would ever clean up — the TTL sweep only unwinds
 *    UNdelivered credentials) — while a withdraw on a COMPLETED pairing
 *    changes nothing (terminals absorb; severing is the operator's call);
 *  - a same-tick grant+withdraw pair cannot resurrect the cancelled row
 *    to 'completed' (handleGrant re-reads after its await, like
 *    handleAccept);
 *  - a late accept landing on a cancelled request is nacked with a
 *    re-sent withdraw, so the accepter can unwind even when the original
 *    courtesy never landed;
 *  - a rate-limited refusal from a real sidecar stays TRANSIENT: the row
 *    keeps retrying instead of going terminal (pins the engine's reading
 *    of the sidecar's literal reason string, end to end).
 *
 * ⚠ SIDECAR-VERSION GATE: needs a DM-capable sidecar (≥v1.0.3) — the
 * suite skips wholesale where no binary exists and probe-skips against a
 * pre-DM build, same as discovery-dm.test.mjs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { RawSidecar, pollUntil } from '../helpers/raw-sidecar.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();

(SIDECAR_BIN ? describe : describe.skip)('federation requests — engine over real DMs', () => {
  let tmpDir, stub, bob;
  let config, manager, fedDb, reqDb, engine, p2p, federation, iroh;
  let libId;
  let sidecarHasDm = false;
  let ourTicket; // our discovery endpoint ticket — how bob addresses us

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedreq-'));
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'music'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory: path.join(tmpDir, 'logs'),
      },
      port: 0,
      discoveryP2p: { enabled: true },
      federation: { enabled: true, acceptRequests: true, serverName: 'Engine Test Server' },
    }));

    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    manager = await import('../../src/db/manager.js');
    manager.initDB();
    libId = Number(manager.getDB().prepare(
      'INSERT INTO libraries (name, root_path) VALUES (?, ?)'
    ).run('music', path.join(tmpDir, 'music')).lastInsertRowid);
    // The raw INSERT bypasses the manager's lazy library cache (already
    // snapshotted by initDB) — drop it so getLibraryByName sees the row,
    // the way the real add-library route would.
    manager.invalidateCache();

    fedDb = await import('../../src/db/federation.js');
    reqDb = await import('../../src/db/federation-requests.js');
    p2p = await import('../../src/state/discovery-p2p.js');
    engine = await import('../../src/state/federation-requests.js');
    federation = await import('../../src/state/federation.js');
    iroh = await import('../../src/state/iroh-common.js');

    // The federation endpoint (for real accept/grant tickets) bridges to a
    // stub backend — its HTTP side is not under test here.
    stub = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    await federation.start({
      targetPort: stub.address().port,
      secretKey: iroh.generateSecretKey(),
      awaitOnline: false,
    });

    await p2p.start();
    ourTicket = p2p.getEndpointTicket();
    engine.subscribe();
    await engine.pushAcceptPolicy();

    bob = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'bob'));
    await bob.ready;
    try {
      await bob.rpc('setDmAccept', { accept: true });
      sidecarHasDm = true;
    } catch (_err) {
      sidecarHasDm = false; // pre-DM binary — every test gates off
    }
    // Seed our address book with bob so bare-id dials (the catalog flow)
    // resolve without external discovery.
    if (sidecarHasDm) { await p2p.join([bob.ticket]); }
  });

  after(async () => {
    if (bob) { await bob.stop(); }
    try { await federation?.stop(); } catch { /* endpoint may be down */ }
    try { await p2p?.stop(); } catch { /* sidecar may be down */ }
    if (stub) { stub.close(); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
    setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
  });

  const gate = (t) => {
    if (!sidecarHasDm) { t.skip('pinned sidecar predates the dm protocol'); return true; }
    return false;
  };

  // A syntactically-valid mstrfed1: ticket for the scripted peer — the
  // endpoint ticket inside is fake (nothing dials it here; testPeer's
  // failure is fire-and-forget), the KEY is what the engine stores.
  const bobTicket = (key, name = "Bob's Server") => federation.buildFederationTicket({
    endpointTicket: 'endpoint-ticket-of-bob',
    key,
    serverName: name,
    libraries: ['bobshare'],
  });

  test('OUT: compose → accept → mutual grant-back → completed', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    const row = await engine.compose({
      peerEndpointId: bob.endpointId,
      message: 'shall we?',
      offeredLibraries: ['music'],
    });
    assert.equal(row.state, 'pending-delivery');

    // Duplicate guard: one active request per peer.
    await assert.rejects(
      engine.compose({ peerEndpointId: bob.endpointId }),
      /already/);

    // Bob's inbox sees the request — sanitized fields, no credentials.
    const evt = await bob.waitForEvent('dm', (e) => e.payload?.type === 'federation-request');
    assert.equal(evt.payload.uuid, row.uuid);
    assert.equal(evt.payload.msg, 'shall we?');
    assert.deepEqual(evt.payload.offer, ['music']);
    assert.ok(!JSON.stringify(evt.payload).includes('fedk_'), 'no credential travels in the request');
    await pollUntil(() => reqDb.getRequestById(row.id).state === 'delivered', { what: 'delivered state' });

    // Bob accepts, wants our offer.
    const r = await bob.rpc('dm', {
      to: ourTicket,
      payload: { type: 'federation-accept', uuid: row.uuid, ticket: bobTicket('fedk_bob_key_1'), wantOffer: true },
    });
    assert.equal(r.delivered, true, 'our transport window is open for the reply');

    // The grant-back lands on bob with a REAL ticket: our endpoint, a key
    // that exists here, scoped to the offered library.
    const grant = await bob.waitForEvent('dm', (e) => e.payload?.type === 'federation-grant');
    assert.equal(grant.payload.uuid, row.uuid);
    const parsed = federation.parseFederationTicket(grant.payload.ticket);
    assert.equal(parsed.endpointTicket, federation.getEndpointTicket());
    assert.deepEqual(parsed.libraries, ['music']);
    const grantKey = fedDb.getFederationKeyByKey(parsed.apiKey);
    assert.ok(grantKey, 'the grant ticket carries a live key');
    assert.equal(grantKey.stream_kbps, config.program.federation.limits.streamKbps,
      'automatic grant-back uses the config-default limits');

    await pollUntil(() => reqDb.getRequestById(row.id).state === 'completed', { what: 'completed state' });
    const done = reqDb.getRequestById(row.id);
    const peer = fedDb.getFederationPeers().find((p) => p.id === done.created_peer_id);
    assert.ok(peer, 'bob became a federation peer');
    assert.equal(done.minted_key_id, grantKey.id);

    // Idempotency: a re-delivered accept changes nothing.
    const peersBefore = fedDb.getFederationPeers().length;
    const keysBefore = fedDb.getFederationKeys().length;
    await bob.rpc('dm', {
      to: ourTicket,
      payload: { type: 'federation-accept', uuid: row.uuid, ticket: bobTicket('fedk_bob_key_1'), wantOffer: true },
    });
    await new Promise((r2) => setTimeout(r2, 500));
    assert.equal(fedDb.getFederationPeers().length, peersBefore, 'no duplicate peer');
    assert.equal(fedDb.getFederationKeys().length, keysBefore, 'no duplicate key');
    assert.equal(reqDb.getRequestById(row.id).state, 'completed');
  });

  test('IN: request → operator accept with custom limits → grant-back → completed', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    const uuid = 'in-happy-0001';
    await bob.rpc('dm', {
      to: ourTicket,
      payload: {
        type: 'federation-request', uuid,
        name: 'Bobby<script>', // control char stripped, rest kept verbatim (UI escapes)
        offer: ['bobshare'],
        msg: 'let me in',
      },
    });
    const row = await pollUntil(() => reqDb.getRequestByUuid(uuid), { what: 'inbox row' });
    assert.equal(row.direction, 'in');
    assert.equal(row.state, 'received');
    assert.equal(row.peer_name, 'Bobby<script>', 'control chars stripped, content stored as data');
    assert.deepEqual(row.offered_libraries, ['bobshare']);
    assert.equal(row.peer_endpoint_id, bob.endpointId, 'sender identity is the QUIC-authenticated id');

    await engine.accept(row.id, {
      libraryIds: [libId],
      vpathNames: ['music'],
      limits: { streamKbps: 1234, dailyMb: 0, maxStreams: 2 },
      expiresAt: null,
      acceptTheirOffer: true,
    });

    const acceptEvt = await bob.waitForEvent('dm', (e) => e.payload?.type === 'federation-accept' && e.payload.uuid === uuid);
    assert.equal(acceptEvt.payload.wantOffer, true);
    const parsed = federation.parseFederationTicket(acceptEvt.payload.ticket);
    const key = fedDb.getFederationKeyByKey(parsed.apiKey);
    assert.equal(key.stream_kbps, 1234, 'accept-dialog limits land on the minted key');
    assert.equal(key.max_streams, 2);
    await pollUntil(() => reqDb.getRequestById(row.id).state === 'granting', { what: 'granting state' });

    await bob.rpc('dm', {
      to: ourTicket,
      payload: { type: 'federation-grant', uuid, ticket: bobTicket('fedk_bob_key_2', 'Bobby Grants') },
    });
    await pollUntil(() => reqDb.getRequestById(row.id).state === 'completed', { what: 'completed state' });
    assert.ok(reqDb.getRequestById(row.id).created_peer_id, 'their grant made them our peer');
  });

  test('RACE: two concurrent operator accepts mint exactly one key', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // A synthetic sender straight off the events bus — the race under test
    // is engine-internal, no wire needed (and no rate-limit spend on bob).
    const racer = 'ab'.repeat(32);
    p2p.events.emit('dm', { from: racer, payload: { type: 'federation-request', uuid: 'race-op-accept-1', name: 'Racer' } });
    const row = await pollUntil(() => reqDb.getRequestByUuid('race-op-accept-1'), { what: 'race inbox row' });

    const keysBefore = fedDb.getFederationKeys().length;
    const opts = {
      libraryIds: [libId], vpathNames: ['music'],
      limits: { streamKbps: 0, dailyMb: 0, maxStreams: 0 },
      expiresAt: null, acceptTheirOffer: false,
    };
    // A double-click: both calls enter in the same tick. Unless the engine
    // keeps the state-check→mint stretch synchronous, both pass the check.
    const results = await Promise.allSettled([engine.accept(row.id, opts), engine.accept(row.id, opts)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one accept wins');
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /cannot accept/);
    assert.equal(fedDb.getFederationKeys().length - keysBefore, 1, 'exactly one key minted');
    const done = reqDb.getRequestById(row.id);
    assert.equal(done.state, 'accepted');
    assert.ok(fedDb.getFederationKeyById(done.minted_key_id), 'the row references the surviving key');

    // Tidy: this exchange goes nowhere (fake peer) — drop it so later tests'
    // transport-window and count math stay clean.
    fedDb.deleteFederationKey(done.minted_key_id);
    reqDb.deleteRequest(row.id);
    await engine.pushAcceptPolicy();
  });

  test('RACE: a double-sent peer accept mints exactly one grant-back key', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    const racePeer = 'cd'.repeat(32);
    const row = await engine.compose({ peerEndpointId: racePeer, offeredLibraries: ['music'] });
    // The background dial to a nonexistent id fails on its own clock; the
    // row stays 'pending-delivery', which handleAccept legitimately acts on.
    const keysBefore = fedDb.getFederationKeys().length;
    const peersBefore = fedDb.getFederationPeers().length;
    const payload = { type: 'federation-accept', uuid: row.uuid, ticket: bobTicket('fedk_race_bob', 'Race Bob'), wantOffer: true };
    // The same accept delivered twice back-to-back: both handlers pass the
    // state check before either mints unless the engine re-reads after its
    // awaits (addPeerFromTicket yields).
    p2p.events.emit('dm', { from: racePeer, payload });
    p2p.events.emit('dm', { from: racePeer, payload });
    await pollUntil(() => ['granting', 'completed'].includes(reqDb.getRequestById(row.id).state), { what: 'granting state' });
    await new Promise((r) => setTimeout(r, 500)); // let the losing handler finish
    assert.equal(fedDb.getFederationPeers().length - peersBefore, 1, 'one peer (UNIQUE api_key dedupe)');
    assert.equal(fedDb.getFederationKeys().length - keysBefore, 1, 'exactly one grant-back key minted');
    const done = reqDb.getRequestById(row.id);
    assert.ok(fedDb.getFederationKeyById(done.minted_key_id), 'the row references the surviving key');

    fedDb.deleteFederationKey(done.minted_key_id);
    reqDb.deleteRequest(row.id);
    await engine.pushAcceptPolicy();
  });

  test('reject sends the courtesy DM and tombstones the peer', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    const uuid = 'in-reject-0001';
    await bob.rpc('dm', { to: ourTicket, payload: { type: 'federation-request', uuid, name: 'Bobby' } });
    const row = await pollUntil(() => reqDb.getRequestByUuid(uuid), { what: 'inbox row' });

    await engine.reject(row.id, 'no thanks');
    assert.equal(reqDb.getRequestById(row.id).state, 'rejected');
    const evt = await bob.waitForEvent('dm', (e) => e.payload?.type === 'federation-reject' && e.payload.uuid === uuid);
    assert.equal(evt.payload.reason, 'no thanks');

    // The tombstone: a fresh request from the same peer is dropped silently.
    await bob.rpc('dm', { to: ourTicket, payload: { type: 'federation-request', uuid: 'in-tombstoned-01', name: 'Bobby' } });
    await new Promise((r2) => setTimeout(r2, 700));
    assert.equal(reqDb.getRequestByUuid('in-tombstoned-01'), null, 'tombstoned peer cannot refill the inbox');
  });

  test('cancel sends the courtesy withdraw', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // The OUT slot to bob is free again (the first request completed).
    const row = await engine.compose({ peerEndpointId: bob.endpointId, offeredLibraries: [] });
    await pollUntil(() => reqDb.getRequestById(row.id).state === 'delivered', { what: 'delivered state' });
    await engine.cancel(row.id);
    assert.equal(reqDb.getRequestById(row.id).state, 'cancelled');
    await bob.waitForEvent('dm', (e) => e.payload?.type === 'federation-withdraw' && e.payload.uuid === row.uuid);
  });

  test('inbox off: transport refuses cold, but stays open for live exchanges (verb-gated)', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    config.program.federation.acceptRequests = false;
    let seed = null;
    // A fresh identity — bob has spent his per-remote rate budget on our
    // limiter by this point in the suite; carol's is clean, so refusals
    // here can only come from the accept flag / verb gate under test.
    const carol = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'carol'));
    try {
      await carol.ready;
      // (a) No live exchanges + inbox off → the transport itself refuses:
      // the sender gets the typed fail-closed answer, nothing reaches Node.
      await engine.pushAcceptPolicy();
      const cold = await carol.rpc('dm', {
        to: ourTicket,
        payload: { type: 'federation-request', uuid: 'inbox-off-00001', name: 'Carol' },
      });
      assert.equal(cold.delivered, false, 'fail-closed at the transport');
      assert.equal(cold.reason, 'not-accepting');

      // (b) A live outbound exchange re-opens the window (replies must be
      // able to land) — but NEW requests are still dropped at the verb
      // gate, silently to the sender, logged here.
      seed = reqDb.createRequest({
        uuid: 'inbox-off-seed-1', direction: 'out', peerEndpointId: bob.endpointId,
        state: 'delivered', ttlSeconds: 3600,
      });
      await engine.pushAcceptPolicy();
      const gated = await carol.rpc('dm', {
        to: ourTicket,
        payload: { type: 'federation-request', uuid: 'inbox-off-00002', name: 'Carol' },
      });
      assert.equal(gated.delivered, true, 'the reply window is open');
      await new Promise((r2) => setTimeout(r2, 700));
      assert.equal(reqDb.getRequestByUuid('inbox-off-00002'), null, 'new requests are verb-gated while the inbox is off');
    } finally {
      await carol.stop();
      if (seed) { reqDb.deleteRequest(seed.id); }
      config.program.federation.acceptRequests = true;
      await engine.pushAcceptPolicy();
    }
  });

  test('a refusing peer makes a cold request terminal (refused)', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    await bob.rpc('setDmAccept', { accept: false });
    try {
      const row = await engine.compose({ peerEndpointId: bob.endpointId });
      await pollUntil(() => reqDb.getRequestById(row.id).state === 'refused', { what: 'refused state' });
      const got = reqDb.getRequestById(row.id);
      assert.equal(got.reject_reason, 'transport: not-accepting');
      assert.equal(got.next_attempt_at, null, 'terminal — no retry armed');
    } finally {
      await bob.rpc('setDmAccept', { accept: true });
    }
  });

  test('an unreachable peer walks the retry ladder', { timeout: 90000 }, async (t) => {
    if (gate(t)) { return; }
    const ghost = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'ghost'));
    await ghost.ready;
    const ghostId = ghost.endpointId;
    await p2p.join([ghost.ticket]); // seed the address book, then kill it
    await ghost.stop();

    const row = await engine.compose({ peerEndpointId: ghostId });
    // The dial burns its failure budget (up to ~25s), then the ladder arms.
    await pollUntil(() => reqDb.getRequestById(row.id).fail_count === 1,
      { timeoutMs: 60000, what: 'first failed attempt' });
    const got = reqDb.getRequestById(row.id);
    assert.equal(got.state, 'pending-delivery', 'still live — not terminal');
    assert.ok(got.next_attempt_at, 'retry armed');
    engine.cancel(row.id); // leave the table quiet for the other tests
  });

  test('crossing guard: compose refuses while the peer has a live inbound request', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // Synthetic inbound off the events bus — the guard under test is pure
    // engine/DB, no wire needed.
    const crosser = 'ef'.repeat(32);
    p2p.events.emit('dm', { from: crosser, payload: { type: 'federation-request', uuid: 'cross-guard-01', name: 'Crosser' } });
    const inRow = await pollUntil(() => reqDb.getRequestByUuid('cross-guard-01'), { what: 'crossing inbox row' });

    await assert.rejects(engine.compose({ peerEndpointId: crosser }), /already sent you/);
    assert.equal(reqDb.listRequests().filter((r) => r.peer_endpoint_id === crosser).length, 1,
      'the refused compose left no row behind');

    // A terminal inbound frees the slot: rejecting theirs makes composing
    // our own legitimate again (the operator changed their mind and leads).
    await engine.reject(inRow.id);
    const out = await engine.compose({ peerEndpointId: crosser });
    assert.equal(out.state, 'pending-delivery');

    // Tidy: both exchanges go nowhere (fake peer).
    engine.cancel(out.id);
    reqDb.deleteRequest(out.id);
    reqDb.deleteRequest(inRow.id);
    await engine.pushAcceptPolicy();
  });

  test('withdraw crossing our accept revokes the unclaimed key', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // A fresh identity so this test's DM budget is its own.
    const erin = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'erin'));
    try {
      await erin.ready;
      await erin.rpc('setDmAccept', { accept: true }); // erin must be able to RECEIVE our accept ticket
      await p2p.join([erin.ticket]);

      const uuid = 'in-withdraw-001';
      await erin.rpc('dm', {
        to: ourTicket,
        payload: { type: 'federation-request', uuid, name: 'Erin', offer: ['erinshare'] },
      });
      const row = await pollUntil(() => reqDb.getRequestByUuid(uuid), { what: 'erin inbox row' });

      await engine.accept(row.id, {
        libraryIds: [libId], vpathNames: ['music'],
        limits: { streamKbps: 0, dailyMb: 0, maxStreams: 0 },
        expiresAt: null, acceptTheirOffer: true,
      });
      // The ticket reaches erin and the row settles in 'granting' — the
      // state whose minted key the TTL sweep deliberately never revokes
      // (the credential WAS delivered), i.e. the state that used to strand.
      await erin.waitForEvent('dm', (e) => e.payload?.type === 'federation-accept' && e.payload.uuid === uuid);
      await pollUntil(() => reqDb.getRequestById(row.id).state === 'granting', { what: 'granting state' });
      const keyId = reqDb.getRequestById(row.id).minted_key_id;
      assert.ok(fedDb.getFederationKeyById(keyId), 'the minted key is live before the withdraw');

      // Erin cancelled instead of granting (its cancel can only happen
      // while its own row never consumed our ticket — the key is claimable
      // by nobody).
      await erin.rpc('dm', { to: ourTicket, payload: { type: 'federation-withdraw', uuid } });
      await pollUntil(() => reqDb.getRequestById(row.id).state === 'cancelled', { what: 'cancelled state' });
      assert.ok(!fedDb.getFederationKeyById(keyId), 'the unclaimed key was revoked');
      assert.equal(reqDb.getRequestById(row.id).next_attempt_at, null, 'nothing left owing');

      reqDb.deleteRequest(row.id);
      await engine.pushAcceptPolicy();
    } finally {
      await erin.stop();
    }
  });

  test('a withdraw on a completed pairing changes nothing (terminals absorb)', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // The single most dangerous regression surface of the withdraw-cleanup
    // branch: it must never grow to include 'completed'. Seeded directly —
    // the guard under test is pure engine/DB.
    const peer = '12'.repeat(32);
    const key = fedDb.createFederationKey('terminal-absorb-test', [libId],
      { streamKbps: 0, dailyMb: 0, maxStreams: 0 }, null);
    const row = reqDb.createRequest({
      uuid: 'in-completed-01', direction: 'in', peerEndpointId: peer,
      state: 'received', ttlSeconds: 3600,
    });
    reqDb.updateRequest(row.id, { state: 'completed', mintedKeyId: key.id });

    p2p.events.emit('dm', { from: peer, payload: { type: 'federation-withdraw', uuid: 'in-completed-01' } });
    // handleWithdraw runs synchronously inside the emit (no awaits on its
    // path) — assert directly.
    assert.equal(reqDb.getRequestById(row.id).state, 'completed', 'the terminal row did not move');
    assert.ok(fedDb.getFederationKeyById(key.id), 'the delivered credential survives a post-completion withdraw');

    fedDb.deleteFederationKey(key.id);
    reqDb.deleteRequest(row.id);
    await engine.pushAcceptPolicy();
  });

  test('RACE: a same-tick grant+withdraw pair cannot resurrect the row', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // The row's own authenticated peer sends grant then withdraw
    // back-to-back (one pipe chunk → both dm events in one macrotask).
    // handleGrant suspends at addPeerFromTicket's await; handleWithdraw —
    // no awaits — runs to completion inside that suspension (cancelled +
    // key revoked). Without the post-await re-read, handleGrant's resume
    // would stomp 'cancelled' with 'completed', erasing the revocation
    // record on a row whose credential is dead.
    const peer = '34'.repeat(32);
    const key = fedDb.createFederationKey('grant-race-test', [libId],
      { streamKbps: 0, dailyMb: 0, maxStreams: 0 }, null);
    const row = reqDb.createRequest({
      uuid: 'grant-race-001', direction: 'in', peerEndpointId: peer,
      state: 'received', ttlSeconds: 3600,
    });
    reqDb.updateRequest(row.id, { state: 'granting', mintedKeyId: key.id });

    const payloadGrant = { type: 'federation-grant', uuid: 'grant-race-001', ticket: bobTicket('fedk_grant_race', 'Grant Racer') };
    p2p.events.emit('dm', { from: peer, payload: payloadGrant });
    p2p.events.emit('dm', { from: peer, payload: { type: 'federation-withdraw', uuid: 'grant-race-001' } });

    await pollUntil(() => reqDb.getRequestById(row.id).state === 'cancelled', { what: 'cancelled state' });
    await new Promise((r) => setTimeout(r, 300)); // give a stomping resume time to betray itself
    assert.equal(reqDb.getRequestById(row.id).state, 'cancelled', 'the withdraw stands — no resurrection to completed');
    assert.ok(!fedDb.getFederationKeyById(key.id), 'the revocation stands');

    // The grant's ticket may have added its peer before the guard bailed —
    // deliberate (logged for the operator); tidy it here.
    const zombie = fedDb.getFederationPeers().find((p) => p.api_key === 'fedk_grant_race');
    if (zombie) { fedDb.deleteFederationPeer(zombie.id); }
    reqDb.deleteRequest(row.id);
    await engine.pushAcceptPolicy();
  });

  test('a late accept after cancel is nacked so the accepter can unwind', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    const frank = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'frank'));
    try {
      await frank.ready;
      await frank.rpc('setDmAccept', { accept: true }); // frank must be able to RECEIVE the nack
      await p2p.join([frank.ticket]);

      const row = await engine.compose({ peerEndpointId: frank.endpointId });
      await frank.waitForEvent('dm', (e) => e.payload?.type === 'federation-request' && e.payload.uuid === row.uuid);
      await pollUntil(() => reqDb.getRequestById(row.id).state === 'delivered', { what: 'delivered state' });

      // Cancel with the courtesy withdraw LOST (an offline blip): flip the
      // row terminal directly instead of engine.cancel(), so the only
      // withdraw frank can ever see is the nack under test.
      reqDb.updateRequest(row.id, { state: 'cancelled', nextAttemptInSeconds: null });

      const peersBefore = fedDb.getFederationPeers().length;
      const keysBefore = fedDb.getFederationKeys().length;
      // Frank accepted before learning of the cancel — the crossing race.
      await frank.rpc('dm', {
        to: ourTicket,
        payload: { type: 'federation-accept', uuid: row.uuid, ticket: bobTicket('fedk_frank_late', 'Frank'), wantOffer: false },
      });

      // The late accept is ignored AND answered: frank gets a fresh
      // withdraw for the uuid, telling it to unwind its minted key.
      await frank.waitForEvent('dm', (e) => e.payload?.type === 'federation-withdraw' && e.payload.uuid === row.uuid);
      assert.equal(reqDb.getRequestById(row.id).state, 'cancelled', 'the dead row did not move');
      assert.equal(fedDb.getFederationPeers().length, peersBefore, 'no peer added from the late ticket');
      assert.equal(fedDb.getFederationKeys().length, keysBefore, 'nothing minted for a dead exchange');

      reqDb.deleteRequest(row.id);
      await engine.pushAcceptPolicy();
    } finally {
      await frank.stop();
    }
  });

  test('a rate-limited refusal is transient: the row retries instead of dying', { timeout: 60000 }, async (t) => {
    if (gate(t)) { return; }
    // The engine matches the sidecar's literal 'rate-limited' reason string
    // across two repos — this pins the round-trip against the real binary:
    // exhaust a fresh peer's per-remote budget for OUR sender identity,
    // then let the engine's own send hit the limiter.
    const dave = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'dave'));
    try {
      await dave.ready;
      await dave.rpc('setDmAccept', { accept: true });
      await p2p.join([dave.ticket]);

      let burned = null;
      for (let i = 0; i < 40; i++) {
        const r = await p2p.sendDm(dave.endpointId, { type: 'probe', uuid: `burn-${i}-0000` });
        if (r.delivered === false) { burned = r; break; }
      }
      assert.ok(burned, 'the per-remote budget never tripped — did the sidecar drop its limiter?');
      assert.equal(burned.reason, 'rate-limited', 'the sidecar still spells the refusal the engine matches on');

      // The window is hot: the engine's first delivery attempt gets the
      // same typed refusal — and must arm a retry, not go terminal.
      const row = await engine.compose({ peerEndpointId: dave.endpointId });
      await pollUntil(() => reqDb.getRequestById(row.id).fail_count === 1, { what: 'rate-limited attempt counted' });
      const got = reqDb.getRequestById(row.id);
      assert.equal(got.state, 'pending-delivery', 'transient — still live');
      assert.equal(got.reject_reason, null, 'no terminal refusal recorded');
      assert.ok(got.next_attempt_at, 'retry armed');

      engine.cancel(row.id); // pending-delivery cancel sends no courtesy — nothing else to rate-limit
      reqDb.deleteRequest(row.id);
      await engine.pushAcceptPolicy();
    } finally {
      await dave.stop();
    }
  });
});
