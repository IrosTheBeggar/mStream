/**
 * util/admin.js loadFile/saveFile: two settings editors in flight together
 * must both land. Every editor is loadFile -> mutate -> saveFile; the second
 * save used to overwrite the file with a document loaded before the first
 * save (last-writer-wins: a trustProxy flip silently lost under a
 * maxRequestSize save, both answered 200). saveFile now merges only the paths
 * the caller changed since its load onto the file's current content when
 * another write landed in between.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadFile, saveFile } from '../../src/util/admin.js';

describe('admin config saves merge instead of clobbering', () => {
  let dir;
  let file;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-cfg-'));
    file = path.join(dir, 'config.json');
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));

  test('two editors that loaded the same document both keep their change', async () => {
    await fs.writeFile(file, JSON.stringify({ port: 3000, trustProxy: false, maxRequestSize: '1MB', subsonic: { mode: 'disabled', port: 4040 } }));
    const a = await loadFile(file);   // editTrustProxy
    const b = await loadFile(file);   // editMaxRequestSize, loaded BEFORE a saved
    a.trustProxy = true;
    await saveFile(a, file);
    b.maxRequestSize = '120MB';
    await saveFile(b, file);          // used to write b's stale trustProxy:false
    assert.deepEqual(await read(), { port: 3000, trustProxy: true, maxRequestSize: '120MB', subsonic: { mode: 'disabled', port: 4040 } });
  });

  test('nested sibling keys survive; the same path is last-writer-wins; deletions apply', async () => {
    await fs.writeFile(file, JSON.stringify({ port: 3000, subsonic: { mode: 'disabled', port: 4040 }, ssl: { cert: 'c', key: 'k' } }));
    const a = await loadFile(file);
    const b = await loadFile(file);
    const c = await loadFile(file);
    a.subsonic.mode = 'separate-port';
    await saveFile(a, file);
    b.subsonic.port = 4041;             // sibling of a's change
    delete b.ssl;                       // removeSSL-style deletion
    await saveFile(b, file);
    c.port = 3001;
    c.subsonic.mode = 'same-port';      // same path as a: later save wins
    await saveFile(c, file);
    assert.deepEqual(await read(), { port: 3001, subsonic: { mode: 'same-port', port: 4041 } });
  });

  test('a document not obtained from loadFile is written as is', async () => {
    await fs.writeFile(file, JSON.stringify({ a: 1, b: 2 }));
    await saveFile({ z: 9 }, file);
    assert.deepEqual(await read(), { z: 9 });
  });

  test('concurrent saves from independent loads all land', async () => {
    await fs.writeFile(file, JSON.stringify({ k0: 0 }));
    const docs = await Promise.all(Array.from({ length: 12 }, () => loadFile(file)));
    await Promise.all(docs.map((d, i) => { d[`k${i + 1}`] = i + 1; return saveFile(d, file); }));
    const doc = await read();
    for (let i = 0; i <= 12; i++) { assert.equal(doc[`k${i}`], i, `k${i} missing after concurrent saves`); }
  });
});
