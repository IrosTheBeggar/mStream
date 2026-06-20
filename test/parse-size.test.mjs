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

test('parseSizeToBytes returns null for malformed input', () => {
  for (const bad of ['banana', '', '5', '5TB', '1.5MB', 'MB', '-1MB', null, undefined, 5]) {
    assert.equal(parseSizeToBytes(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
