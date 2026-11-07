/**
 * Integration tests for GET /transcode/{*filepath} — the main-app transcode
 * route.
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
 *   - MP3 at 256k and 320k, and ?sampleRate= — read back from the encoded
 *     frames, strict per codec, part of the cache key, and advertised per
 *     codec in /api/
 *   - a ?codec= named after an Object.prototype key (constructor,
 *     __proto__, …) falls back to the default like any unknown codec
 *   - bulk jobs (?bulk=1), on a second server capped at one: a held slot
 *     queues the next bulk request (503 + Retry-After when the wait runs
 *     out or the queue is full; a client that hangs up leaves the queue)
 *     while listeners and probes go straight through; a freed slot goes
 *     to the oldest waiter; bulk output never enters the cache, though a
 *     cached copy is served to it
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { BUNDLED_FFMPEG, runFfmpeg } from '../helpers/ffmpeg.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SONG_REL = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';

let server;

function transcodeUrl(relPath, query = 'codec=mp3&bitrate=64k') {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${server.baseUrl}/transcode/${encoded}${query ? `?${query}` : ''}`;
}

// The first MPEG audio frame header after any ID3v2 tag: what the encoder
// actually wrote (CBR, so every frame agrees).
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function firstMp3Frame(buf) {
  let i = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) { // "ID3"
    i = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  }
  for (; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
      return {
        mpeg1: version === 3,
        layer3: ((buf[i + 1] >> 1) & 3) === 1,
        kbps: version === 3 ? MPEG1_L3_KBPS[buf[i + 2] >> 4] : null,
        sampleRate: MPEG_RATES[version]?.[(buf[i + 2] >> 2) & 3] ?? null,
      };
    }
  }
  return null;
}

// Ogg Opus: the OpusHead packet's input sample rate (LE u32 at +12).
function opusHeadRate(buf) {
  const at = buf.indexOf('OpusHead');
  return at < 0 ? null : buf.readUInt32LE(at + 12);
}

describe('GET /transcode/{*filepath}', () => {
  before(async () => {
    server = await startServer({ dlnaMode: 'disabled' });
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

  test('mp3 at 320k and 256k: the frames say so', async () => {
    for (const kbps of [320, 256]) {
      const r = await fetch(transcodeUrl(SONG_REL, `codec=mp3&bitrate=${kbps}k`));
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
      const frame = firstMp3Frame(Buffer.from(await r.arrayBuffer()));
      assert.ok(frame?.mpeg1 && frame.layer3, 'an MPEG-1 Layer III stream');
      assert.equal(frame.kbps, kbps);
    }
  });

  test('sampleRate resamples; without it the source rate stands', async () => {
    const plain = firstMp3Frame(Buffer.from(await (await fetch(transcodeUrl(SONG_REL, 'codec=mp3&bitrate=128k'))).arrayBuffer()));
    assert.equal(plain.sampleRate, 44100, 'the fixture is 44.1 kHz');
    for (const rate of [48000, 32000]) {
      const r = await fetch(transcodeUrl(SONG_REL, `codec=mp3&bitrate=128k&sampleRate=${rate}`));
      assert.equal(r.status, 200);
      assert.equal(firstMp3Frame(Buffer.from(await r.arrayBuffer())).sampleRate, rate);
    }
    const opus = await fetch(transcodeUrl(SONG_REL, 'codec=opus&bitrate=96k&sampleRate=24000'));
    assert.equal(opus.status, 200);
    assert.match(opus.headers.get('content-type') || '', /audio\/ogg/);
    assert.equal(opusHeadRate(Buffer.from(await opus.arrayBuffer())), 24000);
  });

  test('a codec named after an Object.prototype key is an unknown codec: the default, not a 500', async () => {
    // The default codec is opus (config.js).
    for (const name of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
      const head = await fetch(transcodeUrl(SONG_REL, `codec=${name}`), { method: 'HEAD' });
      assert.equal(head.status, 200, name);
      assert.match(head.headers.get('content-type') || '', /audio\/ogg/, name);
    }
    const r = await fetch(transcodeUrl(SONG_REL, 'codec=constructor&bitrate=64k'));
    assert.equal(r.status, 200);
    assert.ok(opusHeadRate(Buffer.from(await r.arrayBuffer())), 'an Ogg Opus stream');
    // ...and a sample rate is checked against the default's rates.
    const rate = await fetch(transcodeUrl(SONG_REL, 'codec=toString&sampleRate=44100'));
    assert.equal(rate.status, 400);
    assert.match((await rate.json()).error, /for opus$/);
  });

  test('a sampleRate the codec cannot open is a 400, before any transcode', async () => {
    for (const q of ['codec=opus&sampleRate=44100', 'codec=mp3&sampleRate=12345', 'codec=mp3&sampleRate=abc',
      'codec=mp3&sampleRate=', 'codec=mp3&sampleRate=44100&sampleRate=48000']) {
      const r = await fetch(transcodeUrl(SONG_REL, q));
      assert.equal(r.status, 400, q);
      assert.match((await r.json()).error, /sampleRate must be one of/, q);
    }
    const head = await fetch(transcodeUrl(SONG_REL, 'codec=opus&sampleRate=44100'), { method: 'HEAD' });
    assert.equal(head.status, 400, 'a probe is told too');
  });

  test('the sample rate is part of the cache key', async () => {
    // Warm the plain from-start entry (64k, 44.1 kHz) until it serves from
    // the cache (a cache hit carries Content-Length)...
    const deadline = Date.now() + 5_000;
    for (;;) {
      const r = await fetch(transcodeUrl(SONG_REL));
      await r.arrayBuffer();
      if (r.headers.get('content-length') !== null) { break; }
      assert.ok(Date.now() < deadline, 'the plain transcode never reached the cache');
      await sleep(250);
    }
    // ...then the same file, codec and bitrate at another rate is a fresh
    // transcode at that rate, never the cached 44.1 kHz copy.
    const r = await fetch(transcodeUrl(SONG_REL, 'codec=mp3&bitrate=64k&sampleRate=32000'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), null, 'not the cached plain copy');
    assert.equal(firstMp3Frame(Buffer.from(await r.arrayBuffer())).sampleRate, 32000);
  });

  test('/api/ lists what each codec takes: mp3 up to 320k, opus and aac to 192k, and their sample rates', async () => {
    const r = await fetch(`${server.baseUrl}/api/`);
    assert.equal(r.status, 200);
    const { codecs } = (await r.json()).features.transcode;
    assert.deepEqual(codecs.mp3.bitrates, ['64k', '96k', '128k', '192k', '256k', '320k']);
    assert.deepEqual(codecs.opus.bitrates, ['64k', '96k', '128k', '192k']);
    assert.deepEqual(codecs.aac.bitrates, ['64k', '96k', '128k', '192k']);
    assert.ok(codecs.mp3.sampleRates.includes(44100) && codecs.mp3.sampleRates.includes(48000));
    assert.deepEqual(codecs.opus.sampleRates, [8000, 12000, 16000, 24000, 48000]);
    // The flat ping payload carries the same object.
    const ping = await (await fetch(`${server.baseUrl}/api/v1/ping`)).json();
    assert.deepEqual(ping.transcode.codecs, codecs);
  });
});

describe('GET /transcode — bulk jobs (?bulk=1)', () => {
  // One bulk slot, a queue of one, a 3 s wait: small enough to fill on
  // purpose. Listeners are never counted.
  const WAIT_MS = 3000;
  let srv, longDir;
  const LONG_REL = 'long/long.flac';

  const url = (rel, query) => {
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    return `${srv.baseUrl}/transcode/${encoded}?${query}`;
  };
  // A bulk transcode whose client stops reading: ten minutes at 320k is far
  // more than the socket buffers hold, so ffmpeg blocks — and keeps the
  // slot — until the request is dropped.
  const holdSlot = () => new Promise((resolve, reject) => {
    const req = http.get(url(LONG_REL, 'codec=mp3&bitrate=320k&bulk=1'), (res) => {
      res.pause();
      resolve({ status: res.statusCode, drop: () => req.destroy() });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') { reject(err); } });
  });

  before(async () => {
    longDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-bulk-'));
    await runFfmpeg(BUNDLED_FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=44100:duration=600', '-ac', '1', path.join(longDir, 'long.flac')]);
    srv = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { long: longDir },
      extraConfig: { transcode: { bulkConcurrency: 1 } },
      env: { MSTREAM_TEST_TRANSCODE_BULK_WAIT_MS: String(WAIT_MS), MSTREAM_TEST_TRANSCODE_BULK_QUEUE_MAX: '1' },
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const r = await fetch(url(SONG_REL, 'codec=mp3&bitrate=64k'));
      await r.arrayBuffer();
      if (r.status !== 500) { break; }
      if (Date.now() > deadline) { throw new Error('transcode route never became ready'); }
      await sleep(250);
    }
  });

  after(async () => {
    await srv?.stop();
    if (longDir) { await fs.rm(longDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('/api/ says the server takes the flag, and how many run at once', async () => {
    const info = await (await fetch(`${srv.baseUrl}/api/`)).json();
    assert.deepEqual(info.features.transcode.bulk, { concurrency: 1 });
  });

  test('a held slot queues the next bulk request; listeners and probes go straight through; the wait ends in a 503', async () => {
    const held = await holdSlot();
    assert.equal(held.status, 200);
    try {
      // A listener is never queued behind bulk work...
      const listener = await fetch(url(SONG_REL, 'codec=mp3&bitrate=64k'));
      assert.equal(listener.status, 200);
      assert.ok((await listener.arrayBuffer()).byteLength > 1000);
      // ...nor is a probe, flag or not.
      const probe = await fetch(url(SONG_REL, 'codec=mp3&bitrate=64k&bulk=1'), { method: 'HEAD' });
      assert.equal(probe.status, 200);

      // (128k: nothing cached at that rate — a cache hit needs no slot.)
      const started = Date.now();
      const queued = await fetch(url(SONG_REL, 'codec=mp3&bitrate=128k&bulk=1'));
      const waited = Date.now() - started;
      assert.equal(queued.status, 503);
      assert.equal(queued.headers.get('retry-after'), '10');
      assert.match((await queued.json()).error, /no bulk transcode slot came free in time/);
      assert.ok(waited >= WAIT_MS - 500, `answered after ${waited}ms; it should have waited about ${WAIT_MS}ms`);
    } finally {
      held.drop();
    }
  });

  test('a freed slot goes to the waiter; a full queue is refused at once; a client that hangs up leaves the queue', async () => {
    // The previous test's slot may still be on its way back.
    let held;
    for (let i = 0; i < 20; i++) {
      held = await holdSlot();
      if (held.status === 200) { break; }
      held.drop();
      await sleep(200);
    }
    assert.equal(held.status, 200, 'the slot came back');
    try {
      // A waiter that hangs up frees its place in the queue...
      const quitter = new AbortController();
      const gone = fetch(url(SONG_REL, 'codec=mp3&bitrate=96k&bulk=1'), { signal: quitter.signal }).catch(() => null);
      await sleep(300);
      quitter.abort();
      await gone;
      await sleep(300);
      // ...so the next one queues, and the one after it finds the queue full.
      const waiter = fetch(url(SONG_REL, 'codec=mp3&bitrate=96k&bulk=1'));
      await sleep(300);
      const full = await fetch(url(SONG_REL, 'codec=mp3&bitrate=96k&bulk=1'));
      assert.equal(full.status, 503);
      assert.equal(full.headers.get('retry-after'), '10');
      assert.match((await full.json()).error, /too many bulk transcodes queued/);

      // Dropping the held transcode hands its slot to the waiter, well
      // inside the waiter's 3 s.
      held.drop();
      held = null;
      const served = await waiter;
      assert.equal(served.status, 200);
      assert.match(served.headers.get('content-type') || '', /audio\/mpeg/);
      assert.ok(firstMp3Frame(Buffer.from(await served.arrayBuffer()))?.layer3, 'a real transcode');
    } finally {
      held?.drop();
    }
  });

  test('bulk output never enters the cache, though a cached copy is served to it', async () => {
    const q = 'codec=mp3&bitrate=192k';
    for (let i = 0; i < 2; i++) {
      const r = await fetch(url(SONG_REL, `${q}&bulk=1`));
      assert.equal(r.status, 200);
      await r.arrayBuffer();
      assert.equal(r.headers.get('content-length'), null, `bulk pull ${i + 1} is a fresh transcode`);
      await sleep(300); // a cache insert lands on ffmpeg's close, a beat after the body
    }
    // Nor did they fill it for a listener: the first plain request is live too...
    const plain = await fetch(url(SONG_REL, q));
    await plain.arrayBuffer();
    assert.equal(plain.headers.get('content-length'), null, 'bulk work left nothing in the cache');
    // ...and once a listener's copy is cached, a bulk request may read it.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const r = await fetch(url(SONG_REL, `${q}&bulk=1`));
      const body = await r.arrayBuffer();
      if (r.headers.get('content-length') !== null) {
        assert.equal(Number(r.headers.get('content-length')), body.byteLength);
        break;
      }
      assert.ok(Date.now() < deadline, 'a bulk request was never served the cached copy');
      await sleep(250);
    }
  });
});
