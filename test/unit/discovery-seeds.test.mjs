/**
 * Community-seeds bootstrap resolution (discovery-seeds.resolveBootstrap) —
 * specifically the MSTREAM_TEST_BAKED_SEEDS hermeticity override that keeps
 * test servers off the real discovery network:
 *
 *  - unset → production semantics: the shipped DEFAULT_SEEDS tickets are in
 *    every useCommunitySeeds bootstrap set;
 *  - '[]'  → the baked list is empty; no resolved set may contain a real
 *    seed ticket. resolveBootstrap unions baked + fetched, which is how the
 *    seed-mechanics suite bridged its fake "Stranger" announcements into
 *    real users' catalogs (2026-07-27) despite stubbing the fetched list;
 *  - JSON entries → synthetic baked seeds, for suites exercising the baked
 *    path against local infrastructure;
 *  - set-but-garbage → fails CLOSED to empty, never open to DEFAULT_SEEDS;
 *  - the override must not touch the operator's own bootstrapPeers.
 *
 * Every case runs {localOnly:true} so resolution stays network-free.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as config from '../../src/state/config.js';
import { resolveBootstrap, DEFAULT_SEEDS } from '../../src/state/discovery-seeds.js';

const ENV_KEY = 'MSTREAM_TEST_BAKED_SEEDS';
const REAL_TICKETS = DEFAULT_SEEDS.map((s) => s.ticket);

let tmpDir;
let savedEnv;

before(async () => {
  savedEnv = process.env[ENV_KEY];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-seeds-unit-'));
  await config.setup(path.join(tmpDir, 'config.json'));
  // Point the cache path into the empty tmp dir so no developer-machine
  // seeds-cache.json can leak entries into these assertions.
  config.program.storage.dbDirectory = tmpDir;
  config.program.discoveryP2p.useCommunitySeeds = true;
  config.program.discoveryP2p.bootstrapPeers = [];
});

after(() => {
  if (savedEnv === undefined) { delete process.env[ENV_KEY]; } else { process.env[ENV_KEY] = savedEnv; }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('discovery seeds — baked-list test override', () => {
  test('unset: production bootstrap includes the shipped seed tickets', async () => {
    delete process.env[ENV_KEY];
    const set = await resolveBootstrap({ localOnly: true });
    for (const ticket of REAL_TICKETS) {
      assert.ok(set.includes(ticket), `expected baked ticket ${ticket.slice(0, 24)}… in the set`);
    }
  });

  test("'[]': the resolved bootstrap set contains no real seed ticket", async () => {
    process.env[ENV_KEY] = '[]';
    const set = await resolveBootstrap({ localOnly: true });
    // Nothing baked, no cache, no user peers — nothing at all.
    assert.deepEqual(set, []);
  });

  test('JSON entries: synthetic baked seeds replace the shipped ones', async () => {
    process.env[ENV_KEY] = JSON.stringify([
      { name: 'unit-seed', ticket: 'unit-seed-ticket-0000000000000000' },
    ]);
    const set = await resolveBootstrap({ localOnly: true });
    assert.deepEqual(set, ['unit-seed-ticket-0000000000000000']);
  });

  test('set but unusable: fails closed to empty, never open to the real seeds', async () => {
    for (const bad of ['not json', '{"seeds":[]}', '"just-a-string"']) {
      process.env[ENV_KEY] = bad;
      assert.deepEqual(await resolveBootstrap({ localOnly: true }), [], `for ${JSON.stringify(bad)}`);
    }
  });

  test("the override leaves the operator's own bootstrapPeers alone", async () => {
    process.env[ENV_KEY] = '[]';
    config.program.discoveryP2p.bootstrapPeers = ['friend-ticket-00000000000000000000'];
    try {
      const set = await resolveBootstrap({ localOnly: true });
      assert.deepEqual(set, ['friend-ticket-00000000000000000000']);
    } finally {
      config.program.discoveryP2p.bootstrapPeers = [];
    }
  });
});
