import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebError from '../../src/util/web-error.js';

test('WebError defaults to 400 when no code is given', () => {
  assert.equal(new WebError('nope').status, 400);
});

test('WebError keeps an explicit valid 4xx/5xx code', () => {
  assert.equal(new WebError('x', 400).status, 400);
  assert.equal(new WebError('x', 403).status, 403);
  assert.equal(new WebError('x', 404).status, 404);
  assert.equal(new WebError('x', 500).status, 500);
  assert.equal(new WebError('x', 599).status, 599);
});

test('WebError falls back to 400 for out-of-range / non-integer codes', () => {
  for (const bad of [200, 301, 399, 600, 999, 4.5, NaN, '404', null]) {
    assert.equal(new WebError('x', bad).status, 400, `expected 400 for code ${JSON.stringify(bad)}`);
  }
});

test('WebError carries the message and is a real Error', () => {
  const e = new WebError('boom', 404);
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'boom');
  assert.equal(e.name, 'WebError');
});
