/**
 * federation_requests (V67) accessor semantics — db/federation-requests.js
 * against a real manager-backed DB:
 *  - uuid uniqueness and the direction CHECK;
 *  - updateRequest's partial patches (only named fields move, updated_at
 *    always does);
 *  - the DM-owing due-retry selection: out/pending-delivery, in/accepted,
 *    out/granting — and NEVER in/granting (that row is waiting to receive);
 *  - the presence kick pulling FUTURE attempts to now, and only those;
 *  - abuse-control queries: inbox count, one-active-per-peer, the 7-day
 *    rejection tombstone;
 *  - TTL expiry sweeping only live states and reporting orphaned minted
 *    keys (accepted/granting rows whose credential DM never confirmed);
 *  - ON DELETE SET NULL keeping the audit row when its key/peer dies.
 *
 * Time comparisons live in SQL (datetime('now')), so tests move rows with
 * SQL offsets rather than JS Date math — the V62 lesson.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir, reqDb, fedDb, manager;

function mkRequest(overrides = {}) {
  return reqDb.createRequest({
    uuid: overrides.uuid ?? `uuid-${Math.random().toString(36).slice(2, 10)}`,
    direction: 'out',
    peerEndpointId: 'peer-aaaaaaaaaaaaaaaa',
    state: 'pending-delivery',
    ttlSeconds: 14 * 24 * 3600,
    ...overrides,
  });
}

// Move a row's timestamp columns around in SQL — the only honest way to
// simulate the passage of time against datetime('now') comparisons.
function shift(id, column, seconds) {
  // `? || ' seconds'` keeps negative offsets valid ('-5 seconds'); the
  // production accessors' '+' prefix form only ever sees non-negatives.
  manager.getDB().prepare(
    `UPDATE federation_requests SET ${column} = datetime('now', ? || ' seconds') WHERE id = ?`
  ).run(seconds, id);
}

describe('federation_requests accessors (V67)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedreq-db-'));
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory: path.join(tmpDir, 'logs'),
      },
      port: 0,
    }));
    const config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    manager = await import('../../src/db/manager.js');
    manager.initDB();
    reqDb = await import('../../src/db/federation-requests.js');
    fedDb = await import('../../src/db/federation.js');
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
    setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
  });

  test('create + fetch round-trips, offered_libraries inflates, uuid is unique', () => {
    const row = mkRequest({ uuid: 'uniq-1', offeredLibraries: ['music', 'tapes'], peerName: 'Bob' });
    assert.equal(row.state, 'pending-delivery');
    assert.deepEqual(row.offered_libraries, ['music', 'tapes']);
    assert.equal(reqDb.getRequestByUuid('uniq-1').id, row.id);
    assert.throws(() => mkRequest({ uuid: 'uniq-1' }), /UNIQUE/);
  });

  test('direction is CHECK-constrained', () => {
    assert.throws(() => mkRequest({ direction: 'sideways' }), /CHECK/);
  });

  test('updateRequest patches only what it is given', () => {
    const row = mkRequest();
    reqDb.updateRequest(row.id, { state: 'delivered', nextAttemptInSeconds: null });
    let got = reqDb.getRequestById(row.id);
    assert.equal(got.state, 'delivered');
    assert.equal(got.next_attempt_at, null);
    assert.equal(got.fail_count, 0, 'untouched fields stay put');
    reqDb.updateRequest(row.id, { failCount: 3, nextAttemptInSeconds: 60 });
    got = reqDb.getRequestById(row.id);
    assert.equal(got.state, 'delivered', 'state untouched by the second patch');
    assert.equal(got.fail_count, 3);
    assert.ok(got.next_attempt_at > got.created_at, 'retry armed in the future');
  });

  test('due-retries picks exactly the DM-owing states, in-granting never', () => {
    const owedOut = mkRequest({ uuid: 'due-1' });                                            // out/pending-delivery
    const owedAccept = mkRequest({ uuid: 'due-2', direction: 'in', state: 'accepted' });
    const owedGrant = mkRequest({ uuid: 'due-3', state: 'granting' });                       // out/granting
    const waiting = mkRequest({ uuid: 'due-4', direction: 'in', state: 'granting' });        // waiting to RECEIVE
    const terminal = mkRequest({ uuid: 'due-5', state: 'rejected' });
    for (const r of [owedOut, owedAccept, owedGrant, waiting, terminal]) {
      shift(r.id, 'next_attempt_at', -5); // all nominally due
    }
    const dueIds = reqDb.getDueRetries(50).map((r) => r.uuid);
    assert.ok(dueIds.includes('due-1') && dueIds.includes('due-2') && dueIds.includes('due-3'));
    assert.ok(!dueIds.includes('due-4'), 'in/granting owes nothing');
    assert.ok(!dueIds.includes('due-5'), 'terminal states owe nothing');
    for (const r of [owedOut, owedAccept, owedGrant, waiting, terminal]) { reqDb.deleteRequest(r.id); }
  });

  test('the presence kick pulls only FUTURE attempts forward, only for that peer', () => {
    const target = mkRequest({ uuid: 'kick-1', peerEndpointId: 'peer-kick', });
    const other = mkRequest({ uuid: 'kick-2', peerEndpointId: 'peer-other' });
    shift(target.id, 'next_attempt_at', 6 * 3600);
    shift(other.id, 'next_attempt_at', 6 * 3600);
    assert.equal(reqDb.markPeerAttemptsDue('peer-kick'), 1);
    const dueIds = reqDb.getDueRetries(50).map((r) => r.uuid);
    assert.ok(dueIds.includes('kick-1'), 'kicked row is due now');
    assert.ok(!dueIds.includes('kick-2'), 'other peers keep their backoff');
    assert.equal(reqDb.markPeerAttemptsDue('peer-kick'), 0, 'already-due rows are not re-touched');
    for (const r of [target, other]) { reqDb.deleteRequest(r.id); }
  });

  test('abuse-control queries: inbox count, active-per-peer, tombstone window', () => {
    const inbox = mkRequest({ uuid: 'ab-1', direction: 'in', state: 'received', peerEndpointId: 'peer-ab' });
    assert.equal(reqDb.countPendingInbound(), 1);
    assert.equal(reqDb.hasActiveFromPeer('peer-ab'), true);
    assert.equal(reqDb.hasActiveFromPeer('peer-unknown'), false);

    reqDb.updateRequest(inbox.id, { state: 'rejected' });
    assert.equal(reqDb.countPendingInbound(), 0);
    assert.equal(reqDb.hasActiveFromPeer('peer-ab'), false, 'rejected is not active');
    assert.equal(reqDb.recentlyRejectedPeer('peer-ab'), true, 'fresh rejection tombstones');
    // Age the rejection out of the 7-day window.
    manager.getDB().prepare(
      `UPDATE federation_requests SET updated_at = datetime('now', '-8 days') WHERE id = ?`
    ).run(inbox.id);
    assert.equal(reqDb.recentlyRejectedPeer('peer-ab'), false, 'tombstone expires after the window');
    reqDb.deleteRequest(inbox.id);
  });

  test('hasActiveRequests reflects any live row, either direction', () => {
    manager.getDB().exec('DELETE FROM federation_requests'); // earlier tests leave rows
    assert.equal(reqDb.hasActiveRequests(), false);
    const row = mkRequest({ uuid: 'act-1', direction: 'in', state: 'granting' });
    assert.equal(reqDb.hasActiveRequests(), true);
    reqDb.updateRequest(row.id, { state: 'completed' });
    assert.equal(reqDb.hasActiveRequests(), false);
    reqDb.deleteRequest(row.id);
  });

  test('TTL expiry sweeps live states only and reports orphaned minted keys', () => {
    const lib = manager.getDB().prepare(
      "INSERT INTO libraries (name, root_path) VALUES ('ttl-lib', '/x')"
    ).run();
    const key = fedDb.createFederationKey('ttl-key', [Number(lib.lastInsertRowid)]);

    const orphan = mkRequest({ uuid: 'ttl-1', direction: 'in', state: 'accepted' });
    reqDb.updateRequest(orphan.id, { mintedKeyId: key.id });
    const plain = mkRequest({ uuid: 'ttl-2', state: 'delivered' });
    const done = mkRequest({ uuid: 'ttl-3', state: 'completed' });
    for (const r of [orphan, plain, done]) { shift(r.id, 'expires_at', -5); }

    const { expired, orphanKeyIds } = reqDb.expireOverdueRequests();
    assert.equal(expired, 2, 'the two live rows expire');
    assert.deepEqual(orphanKeyIds, [key.id], 'the undelivered accept ticket key is reported');
    assert.equal(reqDb.getRequestById(orphan.id).state, 'expired');
    assert.equal(reqDb.getRequestById(plain.id).state, 'expired');
    assert.equal(reqDb.getRequestById(done.id).state, 'completed', 'terminal rows are untouched');
    for (const r of [orphan, plain, done]) { reqDb.deleteRequest(r.id); }
  });

  test('minted_key_id / created_peer_id go NULL when their targets die, row survives', () => {
    const lib = manager.getDB().prepare(
      "INSERT INTO libraries (name, root_path) VALUES ('fk-lib', '/y')"
    ).run();
    const key = fedDb.createFederationKey('fk-key', [Number(lib.lastInsertRowid)]);
    const peer = fedDb.addFederationPeer({ name: 'fk-peer', endpointTicket: 'et', apiKey: 'fedk_fk_test' });
    const row = mkRequest({ uuid: 'fk-1', state: 'completed' });
    reqDb.updateRequest(row.id, { mintedKeyId: key.id, createdPeerId: peer.id });

    fedDb.deleteFederationKey(key.id);
    fedDb.deleteFederationPeer(peer.id);
    const got = reqDb.getRequestById(row.id);
    assert.equal(got.minted_key_id, null);
    assert.equal(got.created_peer_id, null);
    assert.equal(got.state, 'completed', 'the audit row itself survives');
    reqDb.deleteRequest(row.id);
  });
});
