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

// ── requests the framework itself refused ────────────────────────────────────
// express.json() and the router say "no" before any route runs, and they say
// it with their own error objects. Those used to land in the crash branch: a
// 500 plus an error-level stack for one `{"a": ` — from anyone, because the
// parsers sit ahead of the auth wall (found by the 2026-09-20 smoke round).
//
// The errors below are REAL ones, produced by the installed express: if an
// upgrade changes how they are marked, this fails instead of the server
// quietly going back to 500s.
import express from 'express';
import { Readable } from 'node:stream';

function parseBody(body, headers = {}, opts = {}) {
  const req = Readable.from([Buffer.from(body)], { objectMode: false });
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers };
  req.method = 'POST';
  return new Promise((resolve) => express.json(opts)(req, {}, (err) => resolve(err)));
}

function routeUrl(url) {
  const router = express.Router();
  router.get('/media/:vpath', (_req, res) => res.end('ok'));
  return new Promise((resolve) => router({ url, method: 'GET', headers: {} }, {}, (err) => resolve(err)));
}

const refused = (status, message) => ({ kind: 'web', status, level: 'warn', stack: false, message });

test('a body express.json() cannot parse is a 400 rejection with a fixed message', async () => {
  const broken = await parseBody('{"a": secret-marker}');
  assert.match(broken.message, /secret-marker/, 'precondition: the parser\'s own message quotes the request body');
  assert.deepEqual(classifyError(broken), refused(400, 'Malformed request body'));

  // strict mode: a bare JSON primitive is refused the same way
  assert.deepEqual(classifyError(await parseBody('"just a string"')), refused(400, 'Malformed request body'));
});

test('a body over maxRequestSize is a 413 rejection that names the limit', async () => {
  const tooLarge = await parseBody(JSON.stringify({ a: 'x'.repeat(3000) }), {}, { limit: '1kb' });
  assert.deepEqual(classifyError(tooLarge), refused(413, 'Request body too large (limit 1024 bytes)'));
});

test('a charset or content-encoding the parser does not speak is a 415 rejection', async () => {
  assert.deepEqual(classifyError(await parseBody('{}', { 'content-type': 'application/json; charset=klingon' })),
    refused(415, 'Unsupported request charset'));
  assert.deepEqual(classifyError(await parseBody('{}', { 'content-encoding': 'rot13' })),
    refused(415, 'Unsupported request content-encoding'));
});

test('a URL parameter that does not percent-decode is a 400 rejection', async () => {
  const err = await routeUrl('/media/%E0%A4%A');
  assert.ok(err instanceof URIError, 'precondition: the router raises a URIError');
  assert.deepEqual(classifyError(err), refused(400, 'Malformed URL'));
});

test('a body-parser type this table has never heard of still gets its own status, with the plain reason phrase', () => {
  const e = Object.assign(new Error('something new'), { status: 422, expose: true, type: 'entity.from.the.future' });
  assert.deepEqual(classifyError(e), refused(422, 'Unprocessable Entity'));
});

test('the recognition is NARROW: a bare status is not an instruction to answer with it', () => {
  const crash = { kind: 'unhandled', status: 500, level: 'error', stack: true };
  const cases = {
    // discovery-plugins/http.js providerError: the status describes the CATALOGUE's response
    'a plain Error carrying a status': Object.assign(new Error('catalogue request failed'), { status: 429 }),
    // raw-body's two 5xx types mean our own middleware order is broken
    'a typed 5xx from the body reader': Object.assign(new Error('stream is not readable'), { status: 500, expose: false, type: 'stream.not.readable' }),
    'a typed 4xx that is not exposed': Object.assign(new Error('x'), { status: 400, expose: false, type: 'entity.parse.failed' }),
    'a typed error with a non-integer status': Object.assign(new Error('x'), { status: '400', expose: true, type: 'entity.parse.failed' }),
    'a URIError a route threw itself (no status)': new URIError('URI malformed'),
    'a URIError with some other status': Object.assign(new URIError('x'), { status: 404 }),
  };
  for (const [label, e] of Object.entries(cases)) {
    assert.deepEqual(classifyError(e), crash, label);
  }
  for (const notAnError of [null, undefined, 400, 'entity.parse.failed']) {
    assert.deepEqual(classifyError(notAnError), crash, `thrown ${JSON.stringify(notAnError)}`);
  }
});
