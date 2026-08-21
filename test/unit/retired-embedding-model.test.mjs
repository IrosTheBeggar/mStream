/**
 * Retired embedding-model migration (src/state/config.js).
 *
 * `scanOptions.discoveryModel` is validated with
 * Joi.string().valid(...Object.keys(EMBEDDING_MODELS)), and config.setup()
 * uses validateAsync, which THROWS. So retiring a registry key without a
 * migration turns any config still naming it into a server that refuses to
 * boot -- including an operator who tried the model once and left the line
 * in. These tests pin the coercion, its persistence, and the fact that live
 * keys are never touched.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../../src/state/config.js';
import {
  EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL, RETIRED_EMBEDDING_MODELS,
} from '../../src/db/discovery-features-lib.js';

let tmpDir;

function writeConfig(name, obj) {
  const f = path.join(tmpDir, name);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

describe('retired embedding models', () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-retired-model-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('the retired list and the live registry never overlap', () => {
    for (const key of Object.keys(RETIRED_EMBEDDING_MODELS)) {
      assert.ok(!Object.hasOwn(EMBEDDING_MODELS, key),
        `'${key}' is both retired and live — Joi would accept it and the migration would fight it`);
    }
  });

  test('clap-music-and-speech is retired, not merely deleted', () => {
    assert.ok(Object.hasOwn(RETIRED_EMBEDDING_MODELS, 'clap-music-and-speech'));
  });

  // The whole point: this config used to boot, and must still boot.
  test('a retired model id boots and coerces to the default', async () => {
    const f = writeConfig('retired.json', {
      storage: { dbDirectory: path.join(tmpDir, 'r', 'db') },
      scanOptions: { discoveryModel: 'clap-music-and-speech' },
    });
    await config.setup(f);
    assert.equal(config.program.scanOptions.discoveryModel, DEFAULT_EMBEDDING_MODEL);
  });

  // Sticky, like the lockAdmin -> adminAccess precedent: the operator should
  // not get the warning on every boot forever.
  test('the coercion is persisted to the config file', async () => {
    const f = writeConfig('persist.json', {
      storage: { dbDirectory: path.join(tmpDir, 'p', 'db') },
      scanOptions: { discoveryModel: 'clap-music-and-speech' },
    });
    await config.setup(f);
    const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(onDisk.scanOptions.discoveryModel, DEFAULT_EMBEDDING_MODEL,
      'the retired id must be rewritten on disk, not just in memory');
  });

  // setup() rewrites the config file for its own reasons (generating the
  // secret / subsonicSecret / iroh + federation keys / dlna uuid), so
  // byte-equality proves nothing here. What must hold is that the migration
  // leaves a LIVE id untouched, on disk and in memory.
  test('a live model id is left alone', async () => {
    const f = writeConfig('live.json', {
      storage: { dbDirectory: path.join(tmpDir, 'l', 'db') },
      scanOptions: { discoveryModel: 'test-fake' },
    });
    await config.setup(f);
    assert.equal(config.program.scanOptions.discoveryModel, 'test-fake');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).scanOptions.discoveryModel, 'test-fake');
  });

  test('an unset discoveryModel still defaults, with no migration', async () => {
    const f = writeConfig('unset.json', {
      storage: { dbDirectory: path.join(tmpDir, 'u', 'db') },
    });
    await config.setup(f);
    assert.equal(config.program.scanOptions.discoveryModel, DEFAULT_EMBEDDING_MODEL);
  });

  // A genuinely unknown id is an operator TYPO, not an upgrade artifact --
  // it must still fail loudly rather than be silently coerced.
  test('an unknown (never-valid) model id still fails validation', async () => {
    const f = writeConfig('bogus.json', {
      storage: { dbDirectory: path.join(tmpDir, 'b', 'db') },
      scanOptions: { discoveryModel: 'not-a-real-model' },
    });
    await assert.rejects(() => config.setup(f), /discoveryModel/);
  });
});
