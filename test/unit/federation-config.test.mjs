/**
 * Config: the federation endpoint key is auto-generated and persisted on
 * first boot, stays stable across reloads, and doesn't clobber pre-existing
 * values — and it's a DIFFERENT key than the iroh tunnel's (unlinkable
 * personas). Mirrors test/unit/iroh-config.test.mjs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';

let tmpDir;
function freshConfigPath(name) { return path.join(tmpDir, name); }

describe('federation config secrets', () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fed-cfg-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('generates + persists a 32-byte secretKey distinct from the tunnel key, default off', async () => {
    const f = freshConfigPath('a.json');
    await config.setup(f);
    assert.equal(config.program.federation.enabled, false);
    assert.equal(config.program.federation.serverName, '');
    assert.equal(Buffer.from(config.program.federation.secretKey, 'base64').length, 32);
    assert.notEqual(config.program.federation.secretKey, config.program.iroh.secretKey);

    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(raw.federation.secretKey, config.program.federation.secretKey);
  });

  test('key is stable across a second setup of the same file', async () => {
    const f = freshConfigPath('b.json');
    await config.setup(f);
    const key1 = config.program.federation.secretKey;
    await config.setup(f);
    assert.equal(config.program.federation.secretKey, key1);
  });

  test('does not clobber pre-existing federation values', async () => {
    const f = freshConfigPath('c.json');
    const preKey = Buffer.alloc(32, 9).toString('base64');
    fs.writeFileSync(f, JSON.stringify({ federation: { enabled: true, secretKey: preKey, serverName: 'My Server' } }));
    await config.setup(f);
    assert.equal(config.program.federation.enabled, true);
    assert.equal(config.program.federation.secretKey, preKey);
    assert.equal(config.program.federation.serverName, 'My Server');
  });

  test('a stale syncthing-era federation config still validates (allowUnknown)', async () => {
    const f = freshConfigPath('d.json');
    fs.writeFileSync(f, JSON.stringify({
      federation: { enabled: false, folder: '/old/sync/folder', federateUsersMode: false },
      storage: { syncConfigDirectory: path.join(tmpDir, 'old-sync') },
    }));
    await config.setup(f); // must not throw
    assert.equal(config.program.federation.enabled, false);
    assert.ok(config.program.federation.secretKey, 'secretKey still auto-generated alongside stale keys');
  });
});
