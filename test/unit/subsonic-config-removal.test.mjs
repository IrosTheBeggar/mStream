/**
 * Subsonic-removal config migration (src/state/config.js).
 *
 * `ui` is validated with Joi.string().valid('default', 'velvet') and
 * config.setup() uses validateAsync, which THROWS — so a config file that
 * still selects the deleted bundled Subsonic UI would turn an upgrade into
 * a server that refuses to boot. The stale `subsonic` block and the
 * `subsonicSecret` key material go at the same time. These tests pin the
 * coercion, its persistence, and that clean configs are left alone.
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
  test("ui='subsonic' boots and coerces to 'default', persisted", async () => {
    const f = writeConfig('ui.json', {
      storage: { dbDirectory: path.join(tmpDir, 'u', 'db') },
      ui: 'subsonic',
    });
    await config.setup(f);
    assert.equal(config.program.ui, 'default');
    assert.equal(readBack(f).ui, 'default', 'the stale ui must be rewritten on disk, not just in memory');
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

  test('a config with no Subsonic leftovers keeps its ui and gains no Subsonic keys', async () => {
    const f = writeConfig('clean.json', {
      storage: { dbDirectory: path.join(tmpDir, 'c', 'db') },
      ui: 'velvet',
    });
    await config.setup(f);
    assert.equal(config.program.ui, 'velvet');
    const onDisk = readBack(f);
    assert.equal(onDisk.ui, 'velvet');
    assert.ok(!('subsonic' in onDisk) && !('subsonicSecret' in onDisk),
      'setup() must not reintroduce any Subsonic key (the old subsonicSecret generator is gone)');
  });
});
