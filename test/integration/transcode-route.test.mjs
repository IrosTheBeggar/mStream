/**
 * Integration tests for GET /transcode/{*filepath} — the main-app transcode
 * route (not the Subsonic stream endpoint, which has its own coverage).
 *
 * Boots a real server in public mode (no users → anonymous sentinel sees all
 * libraries) against the shared ffmpeg-generated fixtures, then exercises:
 *   - a real transcode (bytes + content type)
 *   - the LRU cache (second from-start request serves the exact-length copy)
 *   - mtime-aware cache keys (touching the file busts the cached entry)
 *   - 404s for missing files and unknown libraries (used to be an empty 200
 *     and an HTML 500 respectively)
 *   - HEAD as a header-only probe (used to run a full discarded transcode)
 *   - seeked streams bypassing the cache
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SONG_REL = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';

let server;

function transcodeUrl(relPath, query = 'codec=mp3&bitrate=64k') {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${server.baseUrl}/transcode/${encoded}${query ? `?${query}` : ''}`;
}

describe('GET /transcode/{*filepath}', () => {
  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', subsonicMode: 'disabled' });
    // ffmpeg bootstrap (lockInit) resolves asynchronously after boot — poll
    // until the route stops reporting "transcoding disabled".
    const deadline = Date.now() + 15_000;
    for (;;) {
      const r = await fetch(transcodeUrl(SONG_REL));
      if (r.status !== 500) { await r.arrayBuffer(); break; }
      await r.arrayBuffer();
      if (Date.now() > deadline) { throw new Error('transcode route never became ready'); }
      await sleep(250);
    }
  });

  after(async () => { await server.stop(); });

  let firstLength = 0;

  test('transcodes a real file to mp3', async () => {
    const r = await fetch(transcodeUrl(SONG_REL));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 1000, `expected transcoded audio, got ${buf.length} bytes`);
    firstLength = buf.length;
  });

  test('second from-start request is served from the cache (exact Content-Length)', async () => {
    // The cache entry is inserted on ffmpeg's 'close', which can land a beat
    // after the previous response finished — retry briefly.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const r = await fetch(transcodeUrl(SONG_REL));
      assert.equal(r.status, 200);
      const buf = new Uint8Array(await r.arrayBuffer());
      const len = r.headers.get('content-length');
      if (len !== null) {
        assert.equal(Number(len), buf.length);
        assert.equal(buf.length, firstLength, 'cached copy should match the original transcode');
        return;
      }
      if (Date.now() > deadline) {
        assert.fail('cache never produced a Content-Length response');
      }
      await sleep(250);
    }
  });

  test('touching the file busts the cached entry (mtime is part of the key)', async () => {
    const abs = path.join(server.musicDir, ...SONG_REL.split('/').slice(1));
    const now = new Date();
    await fs.utimes(abs, now, now);
    const r = await fetch(transcodeUrl(SONG_REL));
    assert.equal(r.status, 200);
    // A cache hit always carries Content-Length; the live (re-transcode) path
    // intentionally streams chunked without one.
    assert.equal(r.headers.get('content-length'), null, 'expected a fresh transcode, not the stale cache');
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 1000);
  });

  test('missing file → JSON 404 (not an empty 200)', async () => {
    const r = await fetch(transcodeUrl('testlib/Icarus/Be Somebody/nope.mp3'));
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.ok(j.error);
  });

  test('unknown library → JSON 404 (not an HTML 500)', async () => {
    const r = await fetch(transcodeUrl('no-such-lib/track.mp3'));
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.ok(j.error);
  });

  test('HEAD is a header-only probe', async () => {
    const r = await fetch(transcodeUrl(SONG_REL), { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.equal(buf.length, 0);
  });

  test('seeked stream (?offset=) works and bypasses the cache', async () => {
    const r = await fetch(transcodeUrl(SONG_REL, 'codec=mp3&bitrate=64k&offset=0.5'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), null);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100, `expected seeked audio, got ${buf.length} bytes`);
  });
});
