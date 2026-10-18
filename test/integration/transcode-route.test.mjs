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
