/**
 * Admin lyrics-backfill settings (config.lyrics):
 *   GET  /api/v1/admin/lyrics
 *   POST /api/v1/admin/lyrics/backfill
 *   POST /api/v1/admin/lyrics/providers
 *
 * Boots a real server in public mode (zero users → admin endpoints are
 * unauthenticated) and round-trips the settings, asserting defaults,
 * persistence, and input validation.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

let server;
before(async () => {
  // Enabling backfill kicks maybeEnqueueLyrics → forks the worker, which would
  // otherwise hit the real provider APIs. Point every provider base at a dead
  // local port so the background pass fails fast and this test stays hermetic.
  const dead = 'http://127.0.0.1:59999';
  server = await startServer({
    waitForScan: false,
    env: {
      MSTREAM_LRCLIB_BASE: dead, MSTREAM_NETEASE_BASE: dead,
      MSTREAM_KUGOU_SEARCH_BASE: dead, MSTREAM_KUGOU_LYRICS_BASE: dead,
    },
  });
});
after(async () => { await server?.stop(); });

async function getLyrics() {
  const r = await fetch(`${server.baseUrl}/api/v1/admin/lyrics`);
  return { status: r.status, body: await r.json() };
}
async function post(pathname, data) {
  const r = await fetch(`${server.baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.status;
}

test('GET /admin/lyrics returns defaults: backfill off, lrclib only', async () => {
  const { status, body } = await getLyrics();
  assert.equal(status, 200);
  assert.equal(body.backfill, false);
  assert.equal(body.writeSidecar, false);
  assert.deepEqual(body.providers, ['lrclib']);
});

test('toggling backfill persists both ways', async () => {
  assert.equal(await post('/api/v1/admin/lyrics/backfill', { backfill: true }), 200);
  assert.equal((await getLyrics()).body.backfill, true);
  assert.equal(await post('/api/v1/admin/lyrics/backfill', { backfill: false }), 200);
  assert.equal((await getLyrics()).body.backfill, false);
});

test('toggling write-sidecar persists both ways', async () => {
  assert.equal(await post('/api/v1/admin/lyrics/write-sidecar', { writeSidecar: true }), 200);
  assert.equal((await getLyrics()).body.writeSidecar, true);
  assert.equal(await post('/api/v1/admin/lyrics/write-sidecar', { writeSidecar: false }), 200);
  assert.equal((await getLyrics()).body.writeSidecar, false);
});

test('selecting providers persists, order preserved', async () => {
  assert.equal(await post('/api/v1/admin/lyrics/providers', { providers: ['lrclib', 'netease', 'kugou'] }), 200);
  assert.deepEqual((await getLyrics()).body.providers, ['lrclib', 'netease', 'kugou']);
  assert.equal(await post('/api/v1/admin/lyrics/providers', { providers: ['kugou', 'lrclib'] }), 200);
  assert.deepEqual((await getLyrics()).body.providers, ['kugou', 'lrclib']);
});

test('invalid input is rejected (403 — the global Joi-validation status)', async () => {
  // mStream's global error handler maps every Joi.ValidationError to 403
  // (server.js), so these validated endpoints reject bad input the same way.
  assert.equal(await post('/api/v1/admin/lyrics/providers', { providers: [] }), 403);          // min 1
  assert.equal(await post('/api/v1/admin/lyrics/providers', { providers: ['spotify'] }), 403); // unknown source
  assert.equal(await post('/api/v1/admin/lyrics/backfill', {}), 403);                            // missing required
});
