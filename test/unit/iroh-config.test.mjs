/**
 * Config: the Iroh endpoint key + connect secret are auto-generated and
 * persisted on first boot, stay stable across reloads, and don't clobber
 * pre-existing values. Mirrors the secret/subsonicSecret/dlna.uuid precedent.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';

let tmpDir;
function freshConfigPath(name) { return path.join(tmpDir, name); }

describe('iroh config secrets', () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-iroh-cfg-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('generates + persists a 32-byte secretKey and a connectSecret, default off', async () => {
    const f = freshConfigPath('a.json');
    await config.setup(f);
    assert.equal(config.program.iroh.enabled, false);
    assert.equal(Buffer.from(config.program.iroh.secretKey, 'base64').length, 32);
    assert.ok(config.program.iroh.connectSecret && config.program.iroh.connectSecret.length > 0);

    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(raw.iroh.secretKey, config.program.iroh.secretKey);
    assert.equal(raw.iroh.connectSecret, config.program.iroh.connectSecret);
  });

  test('keys are stable across a second setup of the same file', async () => {
    const f = freshConfigPath('b.json');
    await config.setup(f);
    const key1 = config.program.iroh.secretKey;
    const sec1 = config.program.iroh.connectSecret;
    await config.setup(f);
    assert.equal(config.program.iroh.secretKey, key1);
    assert.equal(config.program.iroh.connectSecret, sec1);
  });

  test('does not clobber pre-existing iroh values', async () => {
    const f = freshConfigPath('c.json');
    const preKey = Buffer.alloc(32, 7).toString('base64');
    fs.writeFileSync(f, JSON.stringify({ iroh: { enabled: true, secretKey: preKey, connectSecret: 'mine' } }));
    await config.setup(f);
    assert.equal(config.program.iroh.enabled, true);
    assert.equal(config.program.iroh.secretKey, preKey);
    assert.equal(config.program.iroh.connectSecret, 'mine');
  });
});
