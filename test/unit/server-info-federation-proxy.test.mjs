/**
 * GET /api/'s features.federationProxy (src/api/server-info.js
 * buildFeatures) is read off the stream proxy's own forwarded-header list
 * (src/api/federation-stream.js FORWARD_REQ, via describeProxy). Built in
 * process here, so the list can change under it:
 *
 *  - while the proxy forwards X-mStream-Purpose, features carry exactly
 *    describeProxy()'s { purpose: true };
 *  - once it does not, the key is left out (the key's presence is the
 *    signal, as for `sync`, never `purpose: false`), so a client gating on
 *    the key and one reading `purpose === true` both hear "undeclared".
 *
 * The HTTP layer (who reads the key, ping not carrying it) is
 * test/integration/api-server-info.test.mjs. Its server is a child process,
 * so its literal { purpose: true } cannot tell a value read off the list
 * from a hard-coded one; this file can.
 *
 * No database, no network: config.setup on a temp file (its dbDirectory
 * the temp dir too) is all buildFeatures needs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';
import { buildFeatures } from '../../src/api/server-info.js';
import { describeProxy, FORWARD_REQ } from '../../src/api/federation-stream.js';

describe('features.federationProxy follows what the stream proxy forwards', () => {
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fed-proxy-'));
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ storage: { dbDirectory: tmpDir } }));
    await config.setup(file);
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('forwarded: features carry describeProxy()\'s { purpose: true }', () => {
    const features = buildFeatures();
    assert.deepEqual(features.federationProxy, describeProxy());
    assert.deepEqual(features.federationProxy, { purpose: true });
  });

  test('not forwarded: no key at all, never purpose: false', () => {
    // Take the header off the list (put back below; this file runs in its
    // own process): the proxy stops forwarding it, and /api/ stops saying so.
    const at = FORWARD_REQ.indexOf('x-mstream-purpose');
    assert.ok(at >= 0, 'this build forwards the purpose');
    FORWARD_REQ.splice(at, 1);
    try {
      const features = buildFeatures();
      assert.ok(!('federationProxy' in features), 'left out, as older servers leave it out');
      assert.equal(features.sync, true, 'the other version facts stay');
    } finally {
      FORWARD_REQ.splice(at, 0, 'x-mstream-purpose');
    }
    assert.deepEqual(buildFeatures().federationProxy, { purpose: true });
  });
});
