/**
 * scripts/fetch-retry.mjs — the bundler's release-asset download.
 *
 * build-bun.mjs stages three sha256-pinned assets per bundle and used to give
 * each ONE fetch, so a single transient 5xx from GitHub's release CDN failed
 * the whole bundle job (2026-09-20: HTTP 500 for mstream-player-darwin-arm64
 * on an unrelated PR; a re-run fixed it). These pin the retry policy:
 *
 *   - transient failures are retried: 408/429/5xx, a connection that dies
 *     before the response, and a body that dies mid-download
 *   - a 404 (wrong pin / missing asset) and every other 4xx fail FAST, with
 *     no retry — waiting cannot fix them
 *   - a persistent outage still fails, with the SAME message the single-shot
 *     fetch produced, so the callers' "download failed: HTTP 500" FATAL line
 *     and their MSTREAM_ALLOW_MISSING_* escape hatches are unchanged
 *   - the bytes come back exactly as served: verification stays the caller's
 *     job and needs the real body to hash
 *
 * Hermetic: a loopback server scripts the responses; sleep is injected, so
 * no test actually waits out a backoff.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchBytesWithRetry, RETRY_DELAYS_MS } from '../../scripts/fetch-retry.mjs';

const BODY = Buffer.from('pinned release asset bytes '.repeat(200));

let server;
let base;
let hits;      // request paths, in order
let script;    // per-test: array of handlers consumed one request at a time
let slept;     // delays the helper asked to sleep
let lines;     // retry log lines

const opts = (extra = {}) => ({
  label: 'test-asset',
  sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  log: (line) => { lines.push(line); },
  ...extra,
});

// Response scripts.
const status = (code) => (req, res) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(`status ${code}`); };
const ok = (req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BODY.length }); res.end(BODY); };
const dropConnection = (req) => { req.socket.destroy(); };
const dieMidBody = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BODY.length });
  res.write(BODY.subarray(0, 64), () => { req.socket.destroy(); });
};

describe('fetchBytesWithRetry', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/moved') { res.writeHead(302, { location: '/asset' }); res.end(); return; }
      const handler = script.shift() || ok;
      handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => { hits = []; script = []; slept = []; lines = []; });

  test('500 twice, then 200: retried, and the bytes come back exactly as served', async () => {
    script = [status(500), status(500), ok];
    const bytes = await fetchBytesWithRetry(`${base}/asset`, opts());

    assert.ok(Buffer.isBuffer(bytes));
    assert.deepEqual(bytes, BODY, 'the caller hashes these bytes — they must be the served body');
    assert.equal(hits.length, 3);
    assert.deepEqual(slept, RETRY_DELAYS_MS.slice(0, 2), 'backs off 2 s, then 5 s');
    assert.equal(lines.length, 2, 'one line per retry');
    assert.match(lines[0], /^ {2}test-asset download attempt 1 of 4 failed: HTTP 500 — retrying in 2 s$/);
    assert.match(lines[1], /^ {2}test-asset download attempt 2 of 4 failed: HTTP 500 — retrying in 5 s$/);
  });

  test('404 fails fast: one request, no retry, the message callers already print', async () => {
    script = [status(404)];
    await assert.rejects(() => fetchBytesWithRetry(`${base}/asset`, opts()), { message: 'HTTP 404' });

    assert.equal(hits.length, 1, 'a wrong pin or a missing asset must not be retried');
    assert.deepEqual(slept, []);
    assert.deepEqual(lines, []);
  });

  test('no other 4xx is retried either', async () => {
    for (const code of [400, 401, 403, 410]) {
      hits = []; slept = [];
      script = [status(code)];
      await assert.rejects(() => fetchBytesWithRetry(`${base}/asset`, opts()), { message: `HTTP ${code}` });
      assert.equal(hits.length, 1, `HTTP ${code} must fail on the first response`);
      assert.deepEqual(slept, []);
    }
  });

  test('every status on the transient list is retried', async () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      hits = []; slept = [];
      script = [status(code), ok];
      const bytes = await fetchBytesWithRetry(`${base}/asset`, opts());
      assert.deepEqual(bytes, BODY, `HTTP ${code} then 200 must succeed`);
      assert.equal(hits.length, 2);
      assert.deepEqual(slept, [RETRY_DELAYS_MS[0]]);
    }
  });

  test('a persistent outage still fails — after every attempt, with the unchanged message', async () => {
    script = [status(500), status(500), status(500), status(500), status(500)];
    await assert.rejects(() => fetchBytesWithRetry(`${base}/asset`, opts()), { message: 'HTTP 500' });

    assert.equal(hits.length, RETRY_DELAYS_MS.length + 1, 'one initial attempt plus one per backoff step, then stop');
    assert.deepEqual(slept, RETRY_DELAYS_MS);
    assert.equal(lines.length, RETRY_DELAYS_MS.length);
  });

  test('a connection dropped before the response is a network error, and is retried', async () => {
    script = [dropConnection, ok];
    const bytes = await fetchBytesWithRetry(`${base}/asset`, opts());

    assert.deepEqual(bytes, BODY);
    assert.equal(hits.length, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /attempt 1 of 4 failed: .+ — retrying in 2 s$/, 'the retry line names what went wrong');
  });

  test('a body that dies mid-download is retried, not handed back truncated', async () => {
    script = [dieMidBody, ok];
    const bytes = await fetchBytesWithRetry(`${base}/asset`, opts());

    assert.equal(bytes.length, BODY.length, 'never a truncated body');
    assert.deepEqual(bytes, BODY);
    assert.equal(hits.length, 2);
  });

  test('a network error that never clears rejects with the fetch error itself', async () => {
    script = [dropConnection, dropConnection];
    await assert.rejects(
      () => fetchBytesWithRetry(`${base}/asset`, opts({ delaysMs: [1] })),
      (err) => err instanceof Error && !/^HTTP \d+$/.test(err.message));
    assert.equal(hits.length, 2, 'delaysMs bounds the attempts: one initial + one retry');
  });

  test('redirects are still followed (release downloads redirect to the CDN)', async () => {
    const bytes = await fetchBytesWithRetry(`${base}/moved`, opts());
    assert.deepEqual(bytes, BODY);
    assert.deepEqual(hits, ['/moved', '/asset']);
    assert.deepEqual(slept, []);
  });

  test('the default policy is three short retries', () => {
    assert.deepEqual(RETRY_DELAYS_MS, [2000, 5000, 10000]);
  });
});
