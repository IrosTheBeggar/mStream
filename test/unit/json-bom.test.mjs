/**
 * util/atomic-json.js stripBom/readJsonFile: a config file written by
 * PowerShell 5.1's `Set-Content -Encoding UTF8` carries a UTF-8 BOM, and
 * JSON.parse refuses it — the server used to die on boot with a bare
 * SyntaxError that named nothing (found by mStream#908's Windows smoke).
 * Every read of a user-editable JSON file goes through these now: the boot
 * parse and the uuid re-reads in state/config.js, the admin editors'
 * loadFile, and the pre-flip --boot-probe (which must agree with the boot,
 * or a BOM'd config would block staging that the real boot accepts).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripBom, readJsonFile } from '../../src/util/atomic-json.js';
import { loadFile } from '../../src/util/admin.js';

const BOM = '﻿';

describe('BOM-tolerant JSON reads', () => {
  let dir;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-bom-'));
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('stripBom removes exactly one leading BOM and nothing else', () => {
    assert.equal(stripBom(`${BOM}{}`), '{}');
    assert.equal(stripBom('{}'), '{}');
    assert.equal(stripBom(''), '');
    // Interior U+FEFF is content (a zero-width no-break space), not a BOM.
    assert.equal(stripBom(`{"a":"x${BOM}y"}`), `{"a":"x${BOM}y"}`);
  });

  test('readJsonFile parses a BOM\'d document exactly like a clean one', async () => {
    const file = path.join(dir, 'bom.json');
    await fs.writeFile(file, `${BOM}{ "port": 3999 }`, 'utf8');
    assert.deepEqual(await readJsonFile(file), { port: 3999 });
  });

  test('invalid JSON fails with the file named, not a bare SyntaxError', async () => {
    const file = path.join(dir, 'broken.json');
    await fs.writeFile(file, `${BOM}{ "port": `, 'utf8');
    await assert.rejects(readJsonFile(file), (err) => {
      assert.equal(err.code, 'EJSONPARSE');
      assert.match(err.message, /broken\.json is not valid JSON: /);
      return true;
    });
  });

  test('the admin editors read through it too', async () => {
    const file = path.join(dir, 'admin.json');
    await fs.writeFile(file, `${BOM}{ "port": 3000, "trustProxy": false }`, 'utf8');
    const doc = await loadFile(file);
    assert.equal(doc.trustProxy, false);
  });
});
