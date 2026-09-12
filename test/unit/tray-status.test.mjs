/**
 * tray-status.json — the launcher-facing facts file (src/util/tray-status.js):
 *  - the inbox count is the inbound rows still in `received`, gated on
 *    federation being on and the admin API unlocked (0 otherwise — the tray
 *    must not nag about a room that would only show its gate);
 *  - refresh writes on the first call of a process and on change only; a
 *    repeat with the same facts leaves the file byte-identical;
 *  - the document shape the launcher parses (rust-launcher/src/paths.rs
 *    parse_tray_status): a flat object, `federationInbox` a plain number.
 *
 * Against a real manager-backed DB, like the V67 accessor suite.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir, file, config, manager, reqDb, tray;

function request(direction, state) {
  return reqDb.createRequest({
    uuid: `uuid-${Math.random().toString(36).slice(2, 10)}`,
    direction,
    peerEndpointId: `peer-${Math.random().toString(36).slice(2, 10)}`,
    state,
    ttlSeconds: 14 * 24 * 3600,
  });
}

const readDoc = () => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('tray-status.json (the launcher facts file)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-tray-status-'));
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory: path.join(tmpDir, 'logs'),
      },
      port: 0,
      federation: { enabled: true },
    }));
    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    manager = await import('../../src/db/manager.js');
    manager.initDB();
    reqDb = await import('../../src/db/federation-requests.js');
    tray = await import('../../src/util/tray-status.js');
    file = path.join(tmpDir, 'tray-status.json');
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows locks */ }
    setImmediate(() => process.exit(0)); // module-level timers, like the other DB-backed suites
  });

  test('counts inbound rows in `received` only, gated on federation on and admin unlocked', () => {
    request('in', 'received');
    request('in', 'received');
    request('in', 'accepted');       // already answered: not waiting on anyone here
    request('out', 'pending-delivery'); // ours: waiting on THEM
    assert.equal(tray.federationInbox(), 2);

    config.program.lockAdmin = true;
    assert.equal(tray.federationInbox(), 0, 'a locked admin API has no room to answer from');
    config.program.lockAdmin = false;

    config.program.federation.enabled = false;
    assert.equal(tray.federationInbox(), 0, 'federation off: nothing can be pending');
    config.program.federation.enabled = true;
    assert.equal(tray.federationInbox(), 2);
  });

  test('refresh writes on the first call and then only on change', async () => {
    tray.resetForTests();
    assert.equal(await tray.refresh('first', { file }), true);
    const first = readDoc();
    assert.equal(first.federationInbox, 2);
    assert.ok(!Number.isNaN(Date.parse(first.updatedAt)), `updatedAt is a date: ${first.updatedAt}`);
    assert.deepEqual(Object.keys(first).sort(), ['federationInbox', 'updatedAt'], 'flat, no surprises');

    const bytes = fs.readFileSync(file, 'utf8');
    assert.equal(await tray.refresh('same', { file }), false, 'nothing changed: no write');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'byte-identical');

    // The operator answers one, the other expires: two writes, then zero.
    const [a, b] = reqDb.listRequests().filter((r) => r.direction === 'in' && r.state === 'received');
    reqDb.updateRequest(a.id, { state: 'rejected' });
    assert.equal(await tray.refresh('rejected', { file }), true);
    assert.equal(readDoc().federationInbox, 1);
    reqDb.updateRequest(b.id, { state: 'expired' });
    assert.equal(await tray.refresh('expired', { file }), true);
    assert.equal(readDoc().federationInbox, 0);
    assert.equal(await tray.refresh('idle', { file }), false);
  });

  test('a fresh process rewrites even unchanged facts (a stale file from the last run)', async () => {
    fs.writeFileSync(file, JSON.stringify({ federationInbox: 9, updatedAt: '2000-01-01T00:00:00.000Z' }));
    tray.resetForTests(); // = a new process life
    assert.equal(await tray.refresh('boot', { file }), true);
    assert.equal(readDoc().federationInbox, 0);
  });

  test('writes into a data home that does not exist yet', async () => {
    // A scratch config keeps every storage dir elsewhere, so nothing else
    // creates the data home; the first boot must still land the file.
    const deep = path.join(tmpDir, 'fresh-home', 'mStream', 'tray-status.json');
    tray.resetForTests();
    assert.equal(await tray.refresh('boot', { file: deep }), true);
    assert.equal(JSON.parse(fs.readFileSync(deep, 'utf8')).federationInbox, 0);
  });

  test('kick never throws and never blocks the caller', () => {
    tray.resetForTests();
    assert.doesNotThrow(() => tray.kick('transition'));
  });
});
