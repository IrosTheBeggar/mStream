/**
 * The runtime-switched SQLite driver (src/db/sqlite-driver.js) must behave
 * the same under Bun — where it is the bun:sqlite adapter — as node:sqlite
 * does under Node, for the parts mStream's callers key on:
 *
 *   - Every SQLite failure is a plain Error { code: 'ERR_SQLITE_ERROR',
 *     errcode, errstr } carrying SQLite's own message. The adapter used to
 *     assign `code` onto bun's SQLiteError, whose `code` is read-only, so the
 *     assignment threw a TypeError that replaced the real error — constraint
 *     and BUSY errors on Bun 1.3, every error on Bun 1.4. The FTS5->LIKE
 *     search fallback (src/api/search.js, keyed on `code`) then 500'd, and the
 *     duplicate-peer (/UNIQUE/) and revoked-key (/FOREIGN KEY/, #940) paths
 *     stopped matching.
 *   - run().changes counts the statement's own rows: bun:sqlite's count also
 *     included trigger and FK-cascade writes.
 *   - A closed database refuses every use with ERR_INVALID_STATE. Bun 1.4
 *     still ran a statement prepared before close(), and its row was written.
 *
 * The fixture runs in a child process under each runtime; the Node run is the
 * reference the Bun run is compared against case by case. The bun leg skips
 * where no bun is installed, except in CI (MSTREAM_TEST_BUN_BIN names one
 * explicitly; see test/helpers/bun.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sqlite-error-shapes.mjs');

let tmpRoot;
before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-sqlite-errors-')); });
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 }); });

function runFixture(execPath, label) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  const r = spawnSync(execPath, [FIXTURE, dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `${label} fixture exited ${r.status} (${r.error?.message ?? r.signal ?? ''}):\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// Case -> [errcode, errstr, message] as node:sqlite reports them.
const ERRORS = {
  unique:          [2067, 'constraint failed', /^UNIQUE constraint failed: u\.a$/],
  notNull:         [1299, 'constraint failed', /^NOT NULL constraint failed: n\.a$/],
  check:           [275, 'constraint failed', /^CHECK constraint failed/],
  foreignKey:      [787, 'constraint failed', /^FOREIGN KEY constraint failed$/],
  syntaxExec:      [1, 'SQL logic error', /syntax error/],
  syntaxPrepare:   [1, 'SQL logic error', /syntax error/],
  noSuchTable:     [1, 'SQL logic error', /^no such table: nope$/],
  commitNoTxn:     [1, 'SQL logic error', /no transaction is active/],
  ftsUnterminated: [1, 'SQL logic error', /^unterminated string$/],
  busy:            [5, 'database is locked', /^database is locked$/],
  readOnlyWrite:   [8, 'attempt to write a readonly database', /^attempt to write a readonly database$/],
  openFail:        [14, 'unable to open database file', /^unable to open database file$/],
};
// Case -> message of the ERR_INVALID_STATE node:sqlite throws on a closed database.
const STATE = {
  runAfterClose:     'statement has been finalized',
  getAfterClose:     'statement has been finalized',
  execAfterClose:    'database is not open',
  prepareAfterClose: 'database is not open',
};
const VALUES = {
  ftsOk:          [{ t: 'hello world' }],
  runOk:          { changes: 1, lastInsertRowid: 2 },
  changesTrigger: { changes: 1, lastInsertRowid: 1 },
  changesCascade: { changes: 1, lastInsertRowid: 3 },
  changesMany:    { changes: 2, lastInsertRowid: 3 },
  getMiss:        true,
  execReturns:    'undefined',
  rowsAfterClose: 1,
};

let nodeCases;

describe('node:sqlite (reference)', () => {
  before(() => { nodeCases = runFixture(process.execPath, 'node'); });

  for (const [name, [errcode, errstr, message]] of Object.entries(ERRORS)) {
    test(`${name}: Error ERR_SQLITE_ERROR/${errcode}`, () => {
      const c = nodeCases[name];
      assert.equal(c.ok, false, `${name} did not throw`);
      assert.equal(c.err.isError, true);
      assert.equal(c.err.name, 'Error');
      assert.equal(c.err.code, 'ERR_SQLITE_ERROR');
      assert.equal(c.err.errcode, errcode);
      assert.equal(c.err.errstr, errstr);
      assert.match(c.err.message, message);
    });
  }
  for (const [name, message] of Object.entries(STATE)) {
    test(`${name}: Error ERR_INVALID_STATE`, () => {
      const c = nodeCases[name];
      assert.equal(c.ok, false, `${name} did not throw`);
      assert.equal(c.err.isError, true);
      assert.equal(c.err.code, 'ERR_INVALID_STATE');
      assert.equal(c.err.message, message);
    });
  }
  for (const [name, value] of Object.entries(VALUES)) {
    test(`${name}`, () => { assert.deepEqual(nodeCases[name], { ok: true, value }); });
  }
});

describe('bun', { skip: noBun }, () => {
  let bunCases;
  before(() => {
    nodeCases ??= runFixture(process.execPath, 'node');
    bunCases = runFixture(BUN_BIN, 'bun');
  });

  test('runs every case the node reference runs', () => {
    assert.deepEqual(Object.keys(bunCases), Object.keys(nodeCases));
  });
  for (const name of [...Object.keys(ERRORS), ...Object.keys(STATE), ...Object.keys(VALUES)]) {
    test(`${name} matches node:sqlite`, () => { assert.deepEqual(bunCases[name], nodeCases[name]); });
  }
});
