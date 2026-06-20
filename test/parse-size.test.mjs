import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSizeToBytes } from '../src/util/parse-size.js';

test('parseSizeToBytes parses valid size strings (1024-based)', () => {
  assert.equal(parseSizeToBytes('0'), 0, "'0' is the unlimited sentinel");
  assert.equal(parseSizeToBytes('100KB'), 100 * 1024);
  assert.equal(parseSizeToBytes('500MB'), 500 * 1024 ** 2);
  assert.equal(parseSizeToBytes('2GB'), 2 * 1024 ** 3);
});

test('parseSizeToBytes is case-insensitive and trims', () => {
  assert.equal(parseSizeToBytes('1mb'), 1024 ** 2);
  assert.equal(parseSizeToBytes('  3gb  '), 3 * 1024 ** 3);
});

test('parseSizeToBytes accepts decimals (rounded to whole bytes)', () => {
  assert.equal(parseSizeToBytes('1.5GB'), 1.5 * 1024 ** 3);
  assert.equal(parseSizeToBytes('0.5MB'), 0.5 * 1024 ** 2);
  assert.equal(parseSizeToBytes('2.25MB'), 2.25 * 1024 ** 2);
  assert.equal(parseSizeToBytes('1.5gb'), 1.5 * 1024 ** 3); // case-insensitive
});

test('parseSizeToBytes returns null for malformed input', () => {
  // '.5GB' (no leading digit), '1.GB' (trailing dot) and '1.5.5GB' are rejected.
  for (const bad of ['banana', '', '5', '5TB', 'MB', '-1MB', '.5GB', '1.GB', '1.5.5GB', null, undefined, 5]) {
    assert.equal(parseSizeToBytes(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
