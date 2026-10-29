/**
 * The bulk gate of /transcode (src/api/transcode.js, `_internal`) — what
 * becomes of a ?bulk=1 request's slot when its client, or the server's
 * ffmpeg, is gone by the time the request would start:
 *
 *  - transcoding gone when a queued bulk request is handed its slot (a soft
 *    reboot's reset() while it waited; in this process init() never runs,
 *    so it is gone throughout): the request is told 500 'transcoding
 *    disabled' and the slot comes straight back. Spawned anyway, ffmpeg's
 *    null path threw before anything would free the slot, and the next
 *    bulk requests waited for one that never came;
 *  - a client that hung up before it reached the gate is turned away at
 *    once, holding neither a slot nor one of the queue's places.
 *
 * No library, no ffmpeg: an Express app calls the gate directly. The route
 * itself (queueing, 503s, the cache) is covered by the integration suite,
 * test/integration/transcode-route.test.mjs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// Read once, when transcode.js loads: short, so a regression shows as a
// 503 after two seconds rather than a test that hangs for a minute.
process.env.MSTREAM_TEST_TRANSCODE_BULK_WAIT_MS = '2000';
const config = await import('../../src/state/config.js');
const { _internal } = await import('../../src/api/transcode.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A response the gate can hold a slot for, with no client behind it.
function idleResponse() {
  const res = new EventEmitter();
  res.destroyed = false;
  return res;
}

describe('transcode bulk gate', () => {
  let tmpDir, server, base;
  let lateAnswer = null; // what the gate told a client that had already gone

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-transcode-bulk-'));
    await config.setup(path.join(tmpDir, 'config.json'));
    config.program.transcode.bulkConcurrency = 1;

    const app = express();
    // A bulk request's start, as the route makes it after a cache miss.
    app.get('/start', async (req, res) => {
      try {
        const started = await _internal.startTranscode(req, res, {
          fullPath: path.join(tmpDir, 'track.flac'), filepath: 'lib/track.flac',
          codec: 'mp3', bitrate: '320k', sampleRate: null, offsetSec: 0, cacheKey: 'k', bulk: true,
        });
        if (started) { started.release(); res.status(200).json({ started: true }); }
      } catch (err) {
        res.status(599).json({ error: `threw: ${err.message}` });
      }
    });
    // A request whose client hangs up before it reaches the gate.
    app.get('/late', async (req, res) => {
      await once(res, 'close');
      lateAnswer = await _internal.acquireBulkSlot(res);
      if (typeof lateAnswer === 'function') { lateAnswer(); lateAnswer = 'a slot'; }
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('transcoding gone when a queued request gets its slot: a 500, and the slot comes back', async () => {
    // The one slot, held here, so the request queues for it.
    const releaseHeld = await _internal.acquireBulkSlot(idleResponse());
    assert.equal(typeof releaseHeld, 'function');
    const answer = fetch(`${base}/start`);
    for (let i = 0; i < 50 && _internal.bulkState().queued === 0; i++) { await sleep(20); }
    assert.deepEqual(_internal.bulkState(), { active: 1, queued: 1 });

    releaseHeld();
    const r = await answer;
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, 'transcoding disabled');
    assert.deepEqual(_internal.bulkState(), { active: 0, queued: 0 }, 'the slot came back');

    // So the next one is answered at once instead of waiting out a slot
    // nobody will free.
    const started = Date.now();
    const again = await fetch(`${base}/start`);
    assert.equal(again.status, 500);
    assert.equal((await again.json()).error, 'transcoding disabled');
    assert.ok(Date.now() - started < 1000, `answered after ${Date.now() - started}ms`);
    assert.deepEqual(_internal.bulkState(), { active: 0, queued: 0 });
  });

  test('a client that hung up before the gate is turned away at once: no slot, no place in the queue', async () => {
    const releaseHeld = await _internal.acquireBulkSlot(idleResponse());
    try {
      const quitter = new AbortController();
      const gone = fetch(`${base}/late`, { signal: quitter.signal }).catch(() => null);
      await sleep(100);
      quitter.abort();
      await gone;
      for (let i = 0; i < 50 && lateAnswer === null; i++) { await sleep(20); }
      assert.deepEqual(lateAnswer, { refused: 'gone' });
      assert.deepEqual(_internal.bulkState(), { active: 1, queued: 0 }, 'the held slot only');
    } finally {
      releaseHeld();
    }
    assert.deepEqual(_internal.bulkState(), { active: 0, queued: 0 });
  });
});
