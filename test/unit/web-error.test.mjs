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

// ── classifyError: the terminal handler's severity policy ────────────────────
// The contract that keeps routine rejections OUT of error-level logs: a
// production server once collected ~100 error-level "Server error" lines a
// day from one credential-less client being correctly told 401, burying the
// signal a real 500 would need.
import { classifyError } from '../../src/util/web-error.js';

test('a 4xx WebError is a handled rejection: warn, no stack, its own status', () => {
  assert.deepEqual(classifyError(new WebError('Authentication Error', 401)),
    { kind: 'web', status: 401, level: 'warn', stack: false });
  assert.deepEqual(classifyError(new WebError('nope', 404)),
    { kind: 'web', status: 404, level: 'warn', stack: false });
});

test('a 5xx WebError is chosen server trouble: error level, but message-only', () => {
  assert.deepEqual(classifyError(new WebError('announce failed', 500)),
    { kind: 'web', status: 500, level: 'error', stack: false });
  assert.deepEqual(classifyError(new WebError('binary missing', 503)),
    { kind: 'web', status: 503, level: 'error', stack: false });
});

test('anything else is an unhandled crash: error level, stack attached, plain 500', () => {
  for (const e of [new TypeError('x is not a function'), new Error('boom'), 'a thrown string']) {
    assert.deepEqual(classifyError(e), { kind: 'unhandled', status: 500, level: 'error', stack: true });
  }
});

test('the code-less WebError default (400) classifies as a rejection', () => {
  assert.equal(classifyError(new WebError('bad input')).level, 'warn');
});
