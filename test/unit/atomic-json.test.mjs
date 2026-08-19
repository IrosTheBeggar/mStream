/**
 * util/atomic-json.js: the config-file writer behind every admin save.
 *
 * The soft reboot re-reads the config file within microseconds of the save
 * that triggered it, so a second save racing the first must never let that
 * read see a truncated document (a torn JSON.parse there exits the process).
 * These tests hammer concurrent write/read pairs and assert every read parses
 * to a complete document, that concurrent writes land in call order, and that
 * no temp files are left behind.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../src/util/atomic-json.js';

describe('writeJsonAtomic', () => {
  let dir;
  before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-atomic-')); });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a reader racing concurrent writers always sees a whole document', async () => {
    const file = path.join(dir, 'config.json');
    const big = { pad: 'x'.repeat(20_000), users: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`u${i}`, { admin: i % 2 === 0 }])) };
    await writeJsonAtomic(file, { ...big, n: 0 });
    let torn = 0;
    let reads = 0;
    for (let i = 1; i <= 300; i++) {
      // Two writers and a reader, all in flight at once — the exact shape of
      // "two admin saves + the reboot's config re-read".
      const w1 = writeJsonAtomic(file, { ...big, n: i, w: 1 });
      const w2 = writeJsonAtomic(file, { ...big, n: i, w: 2 });
      const r = fs.readFile(file, 'utf8').then((txt) => {
        reads++;
        try { const doc = JSON.parse(txt); assert.equal(typeof doc.n, 'number'); } catch { torn++; }
      });
      await Promise.all([w1, w2, r]);
    }
    assert.equal(reads, 300);
    assert.equal(torn, 0, `${torn} torn reads out of ${reads}`);
  });

  test('concurrent writes to one file land in call order', async () => {
    const file = path.join(dir, 'order.json');
    const writes = [];
    for (let i = 0; i < 25; i++) { writes.push(writeJsonAtomic(file, { i })); }
    await Promise.all(writes);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { i: 24 });
  });

  test('leaves no temp files next to the target', async () => {
    const names = await fs.readdir(dir);
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), []);
  });

  test('a write to a missing directory rejects and does not hang the chain', async () => {
    const file = path.join(dir, 'nope', 'x.json');
    await assert.rejects(writeJsonAtomic(file, { a: 1 }));
    // The chain for that path is not poisoned: a later valid write works.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, { a: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 2 });
  });
});
