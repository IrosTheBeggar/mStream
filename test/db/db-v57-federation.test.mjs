/**
 * V57 federation tables: the migration is registered and lands, the grant
 * join-table cascades on both parents (key delete and library delete), key
 * uniqueness holds, and the accessor module round-trips keys/grants/peers
 * (incl. the TOFU bind-once guard).
 *
 * Schema assertions run on a bare in-memory chain; the accessor suite
 * bootstraps a temp DB via the canonical config.setup + initDB path (same
 * harness as test/db/render-metadata-by-ids.test.mjs).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

describe('V57 federation schema', () => {
  test('is registered and the fresh chain lands on SCHEMA_VERSION', () => {
    const entry = MIGRATIONS.find((m) => m.version === 57);
    assert.ok(entry, 'V57 missing from MIGRATIONS');
    assert.ok(!entry.rescanRequired, 'pure new tables must not force a rescan');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const { user_version: v } = db.prepare('PRAGMA user_version').get();
    assert.equal(v, SCHEMA_VERSION);
    for (const t of ['federation_keys', 'federation_key_libraries', 'federation_peers']) {
      assert.ok(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t),
        `${t} missing`,
      );
    }
    db.close();
  });

  test('grants cascade from both parents; duplicate keys are rejected', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    db.exec(`
      INSERT INTO libraries (id, name, root_path) VALUES (1, 'music', '/music'), (2, 'vinyl', '/vinyl');
      INSERT INTO federation_keys (id, key, name) VALUES (1, 'fedk_aaa', 'bob');
      INSERT INTO federation_key_libraries (key_id, library_id) VALUES (1, 1), (1, 2);
    `);

    assert.throws(
      () => db.prepare(`INSERT INTO federation_keys (key, name) VALUES ('fedk_aaa', 'mallory')`).run(),
      /UNIQUE/,
    );

    db.prepare('DELETE FROM libraries WHERE id = 2').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM federation_key_libraries').get().c, 1);

    db.prepare('DELETE FROM federation_keys WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM federation_key_libraries').get().c, 0);
    db.close();
  });
});

describe('federation db accessors', () => {
  let tmpDir;
  let fedDb;
  let libMusic, libVinyl;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fed-db-'));
    fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory:       path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory:     path.join(tmpDir, 'logs'),
      },
      port: 0,
    }, null, 2));

    const config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    const dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    fedDb = await import('../../src/db/federation.js');

    const d = dbManager.getDB();
    const num = (r) => Number(r.lastInsertRowid);
    libMusic = num(d.prepare("INSERT INTO libraries (name, root_path) VALUES ('music', '/music')").run());
    libVinyl = num(d.prepare("INSERT INTO libraries (name, root_path) VALUES ('vinyl', '/vinyl')").run());
  });

  after(async () => {
    const dbManager = await import('../../src/db/manager.js');
    try { dbManager.getDB()?.close?.(); } catch { /* may not expose close */ }
    try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    // config.setup pulls in modules with module-level timers (winston
    // rotation, shared-playlist cleanup, etc.) that keep the loop alive; exit
    // explicitly — same pattern as the other DB-backed tests. This describe is
    // declared last in the file, so everything else has already run.
    setImmediate(() => process.exit(0));
  });

  test('mint -> list -> lookup -> grants -> delete round-trip', () => {
    const { id, key } = fedDb.createFederationKey("Bob's NAS", [libMusic, libVinyl]);
    assert.match(key, /^fedk_[A-Za-z0-9_-]{43}$/);

    const listed = fedDb.getFederationKeys().find((k) => k.id === id);
    assert.deepEqual([...listed.library_names].sort(), ['music', 'vinyl']);

    const row = fedDb.getFederationKeyByKey(key);
    assert.equal(row.id, id);
    assert.equal(row.bound_endpoint_id, null);

    assert.deepEqual(
      fedDb.getFederationKeyLibraries(id).map((l) => l.name).sort(),
      ['music', 'vinyl'],
    );

    assert.equal(fedDb.deleteFederationKey(id), true);
    assert.equal(fedDb.getFederationKeyByKey(key), undefined);
  });

  test('a failed grant rolls the whole mint back', () => {
    assert.throws(() => fedDb.createFederationKey('half', [libMusic, 99999])); // 99999: no such library
    assert.equal(fedDb.getFederationKeys().some((k) => k.name === 'half'), false);
  });

  test('TOFU binding binds once; reset re-arms it', () => {
    const { id } = fedDb.createFederationKey('tofu', [libMusic]);
    assert.equal(fedDb.bindFederationKeyEndpoint(id, 'endpoint-A'), true);
    assert.equal(fedDb.bindFederationKeyEndpoint(id, 'endpoint-B'), false, 'second bind must not overwrite');
    assert.equal(fedDb.getFederationKeyById(id).bound_endpoint_id, 'endpoint-A');

    assert.equal(fedDb.resetFederationKeyBinding(id), true);
    assert.equal(fedDb.getFederationKeyById(id).bound_endpoint_id, null);
    assert.equal(fedDb.bindFederationKeyEndpoint(id, 'endpoint-B'), true);
  });

  test('peer CRUD + status cache', () => {
    const peer = fedDb.addFederationPeer({ name: 'Alice', endpointTicket: 'endpointxyz', apiKey: 'fedk_theirs' });
    assert.equal(peer.name, 'Alice');
    assert.equal(peer.last_seen, null);

    assert.equal(fedDb.updateFederationPeerStatus(peer.id, 'ok'), true);
    let row = fedDb.getFederationPeerById(peer.id);
    assert.equal(row.last_status, 'ok');
    assert.ok(row.last_seen, 'ok stamps last_seen');

    assert.equal(fedDb.updateFederationPeerStatus(peer.id, 'unreachable: timeout'), true);
    row = fedDb.getFederationPeerById(peer.id);
    assert.equal(row.last_status, 'unreachable: timeout');
    assert.ok(row.last_seen, 'failure must not clear last_seen');

    assert.equal(fedDb.deleteFederationPeer(peer.id), true);
    assert.equal(fedDb.getFederationPeerById(peer.id), undefined);
  });
});
