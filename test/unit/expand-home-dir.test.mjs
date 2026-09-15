/**
 * expandHomeDir (src/util/esm-helpers.js) — the one `~` rule shared by
 * POST /api/v1/admin/file-explorer and PUT /api/v1/admin/directory.
 *
 * Route-level behaviour (the 4xx answers, the stored root) lives in
 * test/integration/admin-path-validation.test.mjs; this pins the pure
 * expansion rule with an injected home so it reads the same on every
 * platform: only the bare `~` and `~<separator>…` expand, nothing else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { expandHomeDir } from '../../src/util/esm-helpers.js';

const HOME = '/srv/home/mstream';
const home = () => HOME;

test('bare `~` is the home directory itself', () => {
  assert.equal(expandHomeDir('~', home), HOME);
});

test('`~/` and `~\\` prefixes become home + the rest', () => {
  assert.equal(expandHomeDir('~/Music', home), path.join(HOME, 'Music'));
  assert.equal(expandHomeDir('~\\Music', home), path.join(HOME, 'Music'));
  assert.equal(expandHomeDir('~/a/b c/d', home), path.join(HOME, 'a/b c/d'));
  assert.equal(expandHomeDir('~/', home), HOME, 'trailing separator alone is still home');
});

test('`~user` forms and a `~` that is not a prefix are left alone (no user lookups)', () => {
  for (const p of ['~alice/Music', '~foo', 'a/~/b', '/data/~', 'Music~']) {
    assert.equal(expandHomeDir(p, home), p);
  }
});

test('ordinary paths pass through untouched', () => {
  for (const p of ['/abs/path', 'rel/path', 'C:\\Users\\x', '', '.']) {
    assert.equal(expandHomeDir(p, home), p);
  }
});

test('non-strings pass through (Joi has already rejected them upstream)', () => {
  assert.equal(expandHomeDir(undefined, home), undefined);
  assert.equal(expandHomeDir(null, home), null);
});

test('defaults to os.homedir()', () => {
  assert.equal(expandHomeDir('~'), os.homedir());
  assert.equal(expandHomeDir('~/x'), path.join(os.homedir(), 'x'));
});
