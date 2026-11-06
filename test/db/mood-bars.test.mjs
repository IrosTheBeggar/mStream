/**
 * The two-place floor a client writes onto a card agrees with the mood
 * filters' SQL bars, on both runtimes.
 *
 * POST /api/v1/db/mood-scores hands out the stored scores unrounded, and a
 * client that filters offline (the terminal player writing an MP3 player's
 * card) keeps each as a byte, min(100, max(0, floor(score * 100 + 1e-9))),
 * and compares bytes against the bar in percent. That only matches the
 * server if, for every score the worker can store (4 places, 0 to 1) and
 * every bar a filter may ask for (0.10 to 0.90), the byte rule keeps exactly
 * what moodPredicate's SQL keeps — the `>=` of a head that must hold and the
 * `<` under the mirror of one that must not. A plain floor does not (0.29 *
 * 100 is 28.999…); the fixture counts it too, so the comparison is shown to
 * tell the two apart.
 *
 * The SQL runs through the runtime-switched driver in a child process under
 * each runtime: shipped binaries are Bun builds (src/db/sqlite-driver.js),
 * with their own SQLite. The bun leg skips where no bun is installed, except
 * in CI (MSTREAM_TEST_BUN_BIN names one explicitly; see test/helpers/bun.mjs).
 */

import { describe, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mood-bars.mjs');

const SCORES = 10_001;   // 0, 0.0001, …, 1
const BARS = 81;         // 0.10 … 0.90
const KINDS = ['happy', 'relaxed', 'instrumental', 'acoustic', 'party', 'danceable', 'vocals', 'neutralValence', 'neutralEnergy'];

function runFixture(execPath, label) {
  const r = spawnSync(execPath, [FIXTURE], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(r.status, 0, `${label} fixture exited ${r.status} (${r.error?.message ?? r.signal ?? ''}):\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function assertAgrees(t, label, out) {
  t.diagnostic(`${label} (SQLite ${out.sqlite}): ${out.checks} checks, ${out.wrong} wrong; plain floor ${out.plainWrong} wrong`);
  assert.equal(out.scores, SCORES);
  assert.equal(out.bars, BARS);
  assert.deepEqual(out.kinds, KINDS);
  assert.equal(out.checks, SCORES * BARS * KINDS.length);
  assert.equal(out.readBack, 0, 'every stored double reads back exactly');
  assert.equal(out.wrong, 0, `wrong: ${JSON.stringify(out.wrongBy)} first: ${JSON.stringify(out.firstWrong)}`);
  assert.ok(out.plainWrong > 0, 'a plain floor is caught out, so the comparison can tell the rules apart');
}

let nodeOut;

describe('node:sqlite', () => {
  before(() => { nodeOut = runFixture(process.execPath, 'node'); });

  test('the two-place floor keeps exactly what the SQL keeps: 0 wrong', (t) => {
    assertAgrees(t, 'node', nodeOut);
  });
});

describe('bun', { skip: noBun }, () => {
  let bunOut;
  before(() => {
    nodeOut ??= runFixture(process.execPath, 'node');
    bunOut = runFixture(BUN_BIN, 'bun');
  });

  test('the two-place floor keeps exactly what the SQL keeps: 0 wrong', (t) => {
    assertAgrees(t, 'bun', bunOut);
  });

  test('the same counts as node:sqlite', () => {
    const { sqlite: _b, ...bun } = bunOut;
    const { sqlite: _n, ...node } = nodeOut;
    assert.deepEqual(bun, node);
  });
});
