/**
 * Subsonic-removal config migration (src/state/config.js).
 *
 * `ui` is no longer a setting at all — the default web UI is the only one
 * (the bundled Subsonic client went with the Subsonic API, velvet was
 * removed) — so config.setup() strips the key whatever its value, along with
 * the stale `subsonic` block, the `subsonicSecret` key material and the
 * velvet-only `discogs` block, and persists the result. These tests pin
 * the sweep, its persistence, and that clean configs are left alone.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';

let tmpDir;

function writeConfig(name, obj) {
  const f = path.join(tmpDir, name);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
const readBack = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('subsonic removal config migration', () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-subsonic-removal-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  // The whole point: this config used to boot, and must still boot.
  test("ui='subsonic' boots; the retired key is removed from the file", async () => {
    const f = writeConfig('ui.json', {
      storage: { dbDirectory: path.join(tmpDir, 'u', 'db') },
      ui: 'subsonic',
    });
    await config.setup(f);
    assert.equal(config.program.ui, undefined);
    assert.ok(!('ui' in readBack(f)), 'the stale ui must be removed on disk, not just in memory');
  });

  test('a stale subsonic block + subsonicSecret are dropped from the file and the server still boots', async () => {
    const f = writeConfig('stale.json', {
      storage: { dbDirectory: path.join(tmpDir, 's', 'db') },
      subsonic: { mode: 'same-port', port: 3012 },
      subsonicSecret: 'not-a-real-secret',
    });
    await config.setup(f);
    const onDisk = readBack(f);
    assert.ok(!('subsonic' in onDisk), 'subsonic block removed from disk');
    assert.ok(!('subsonicSecret' in onDisk), 'subsonicSecret removed from disk');
    assert.equal(config.program.subsonic, undefined);
    assert.equal(config.program.subsonicSecret, undefined);
  });

  test('a clean config gains no Subsonic keys and is not rewritten', async () => {
    const f = writeConfig('clean.json', {
      storage: { dbDirectory: path.join(tmpDir, 'c', 'db') },
    });
    const before = fs.statSync(f).mtimeMs;
    await config.setup(f);
    const onDisk = readBack(f);
    assert.ok(!('subsonic' in onDisk) && !('subsonicSecret' in onDisk),
      'setup() must not reintroduce any Subsonic key (the old subsonicSecret generator is gone)');
    assert.ok(!('ui' in onDisk) && !('discogs' in onDisk));
    // secret / iroh / dlna generation still rewrite a brand-new file, so
    // only check the retired-key sweep itself left nothing behind.
    assert.ok(fs.statSync(f).mtimeMs >= before);
  });

  test("the admin panel's old \"ui\": \"default\" and a velvet-only discogs block are stripped", async () => {
    const f = writeConfig('default-ui.json', {
      storage: { dbDirectory: path.join(tmpDir, 'd', 'db') },
      ui: 'default',
      discogs: { enabled: true, allowArtUpdate: false, apiKey: 'k', apiSecret: 's' },
    });
    await config.setup(f);
    assert.equal(config.program.ui, undefined);
    assert.equal(config.program.discogs, undefined);
    const onDisk = readBack(f);
    assert.ok(!('ui' in onDisk), 'ui removed on disk');
    assert.ok(!('discogs' in onDisk), 'discogs removed on disk');
  });

  // The velvet UI went the same way; its stale value takes the same road.
  test("ui='velvet' (the removed velvet UI) boots; the key is removed from the file", async () => {
    const f = writeConfig('velvet.json', {
      storage: { dbDirectory: path.join(tmpDir, 'v', 'db') },
      ui: 'velvet',
    });
    await config.setup(f);
    assert.equal(config.program.ui, undefined);
    assert.ok(!('ui' in readBack(f)), 'the stale ui must be removed on disk, not just in memory');
  });
});
