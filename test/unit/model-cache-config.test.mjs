/**
 * storage.modelCacheDirectory default derivation (src/state/config.js).
 *
 * The old default (appRoot/model-cache) broke container images whose config
 * template points storage at a writable mount but predates the key: the app
 * dir is root-owned there (linuxserver.io's /app/mstream under PUID), so the
 * first embed run died with a bare EACCES. The default now derives from
 * dbDirectory's parent — writable by construction. There is no migration
 * from the old location: the cache holds only re-downloadable pinned
 * weights, so old installs simply re-fetch once. Boot creates the dir
 * best-effort: an unwritable model cache must never stop the music server.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';
import { appRoot } from '../../src/util/esm-helpers.js';

let tmpDir;

describe('deriveModelCacheDirectory', () => {
  test('derives a sibling of the configured dbDirectory', () => {
    assert.equal(config.deriveModelCacheDirectory('/config/db'),
      path.join('/config', 'model-cache'));
  });

  test('unset dbDirectory derives from the default save/db', () => {
    assert.equal(config.deriveModelCacheDirectory(undefined),
      path.join(appRoot, 'save', 'model-cache'));
  });
});

describe('storage.modelCacheDirectory through config.setup()', () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-modelcache-cfg-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  function writeConfig(name, obj) {
    const f = path.join(tmpDir, name);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  }

  test('defaults to a sibling of dbDirectory and is created at boot', async () => {
    const f = writeConfig('a.json', { storage: { dbDirectory: path.join(tmpDir, 'a', 'db') } });
    await config.setup(f);
    const expected = path.join(tmpDir, 'a', 'model-cache');
    assert.equal(config.program.storage.modelCacheDirectory, expected);
    assert.ok(fs.existsSync(expected), 'setup() creates the model cache best-effort');
  });

  test('an explicit modelCacheDirectory is used verbatim', async () => {
    const explicit = path.join(tmpDir, 'b', 'my-models');
    const f = writeConfig('b.json', {
      storage: { dbDirectory: path.join(tmpDir, 'b', 'db'), modelCacheDirectory: explicit },
    });
    await config.setup(f);
    assert.equal(config.program.storage.modelCacheDirectory, explicit);
    assert.ok(fs.existsSync(explicit));
  });

  // The music server must boot and stream even when model weights have
  // nowhere to land — the discovery pass degrades on its own, and setup()
  // warns with the config key instead of throwing.
  test('an uncreatable model cache dir must not kill boot',
    { skip: (process.platform === 'win32' || process.getuid?.() === 0)
      && 'POSIX non-root only: chmod denial does not bind here' },
    async () => {
      const roParent = path.join(tmpDir, 'ro');
      fs.mkdirSync(roParent, { recursive: true });
      fs.chmodSync(roParent, 0o555);
      try {
        const f = writeConfig('c.json', {
          storage: {
            dbDirectory: path.join(tmpDir, 'c', 'db'),
            modelCacheDirectory: path.join(roParent, 'model-cache'),
          },
        });
        await config.setup(f);
        assert.ok(!fs.existsSync(path.join(roParent, 'model-cache')));
      } finally {
        fs.chmodSync(roParent, 0o755);
      }
    });
});
