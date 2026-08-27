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
 *  - reject sends the courtesy DM and tombstones the peer for 7 days
 *    (the next request from them is dropped without a row);
 *  - cancel sends the courtesy withdraw;
 *  - a transport-refused cold request goes terminal ('refused');
 *  - an unreachable peer walks the retry ladder instead of dying;
 *  - the inbox toggle gates NEW requests at the verb level while replies
 *    keep flowing (the open-for-replies transport window).
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
});
