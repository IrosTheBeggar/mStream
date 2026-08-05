/**
 * Unit tests for src/util/image-thumbs.js — album-art thumbnail generation.
 *
 * Origin: audit finding H1. Thumbnails were produced by Jimp (a pure-JS
 * decoder) on the event loop, so any authenticated user could upload a small
 * file that decoded huge and stalled the whole server (2.3 s of blocked loop
 * from a 92 KB 4000×4000 JPEG).
 *
 * Two rounds of adversarial review then proved that reading dimensions from
 * the header CANNOT bound decode cost — JPEG frames hidden after a scan, PNG
 * decoy chunks and interlaced deflate bombs, GIF logical-screen lies, WebP
 * VP8X canvas lies each turned a KB-sized upload back into a multi-second
 * main-thread stall. So the invariant under test is architectural:
 *
 *   untrusted bytes are decoded by ffmpeg in a CHILD process, or not at all,
 *   with ffprobe (a real parser) as the authority on size.
 *
 * Pinned here: header sniffing stays honest or says "unknown"; the format
 * gate; thumbnails for every real format including animations; and — the
 * important half — every lying/oversized/unreadable input ending in "no
 * thumbnails" rather than a decode.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  dimensionsOf, tooManyPixels, generateThumbnails, isSupportedImage, MAX_IMAGE_PIXELS,
} from '../../src/util/image-thumbs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = path.join(REPO_ROOT, 'bin', 'ffmpeg', `ffmpeg${EXE}`);
const FFPROBE = path.join(REPO_ROOT, 'bin', 'ffmpeg', `ffprobe${EXE}`);
const BINS = { ffmpegPath: FFMPEG, ffprobePath: FFPROBE };

// A real 64×64 VP8 WebP (82 bytes), generated once with a libwebp-enabled
// ffmpeg and EMBEDDED because not every CI ffmpeg carries a WebP encoder
// (macOS homebrew-ffmpeg tap: decodes WebP, can't encode it). Decode-side
// coverage must not depend on an encoder existing; the one encoder-side
// test below probes for it and skips honestly.
const WEBP_64 = Buffer.from(
  'UklGRkoAAABXRUJQVlA4ID4AAADQAwCdASpAAEAAPpFIoEwlpCMiIggAsBIJaQB2AAAgbqag'
  + 'CvELcgAA/uwmX/rQtCBz//5Sv58/IPhkAAAAAA==', 'base64');

// Hand-craft a RIFF/WEBP container around one chunk — for header-parser
// tests, where building the bytes directly is more precise than asking an
// encoder to (and works on encoder-less ffmpeg builds).
function craftWebp(fourcc, body) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'), u32(4 + 8 + body.length), Buffer.from('WEBP', 'latin1'),
    Buffer.from(fourcc, 'latin1'), u32(body.length), body,
  ]);
}

let tmpDir;
let hasWebpEncoder = false;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

// A solid-colour still at an exact size, in the container the name implies.
async function makeImage(name, size) {
  const out = path.join(tmpDir, name);
  await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=blue:s=${size}`, '-frames:v', '1', '-q:v', '12', out]);
  return out;
}

// A multi-frame animation — the class that made ffmpeg's image2 muxer abort
// (and silently fall back to in-process decoding) before -frames:v 1.
async function makeAnimation(name, size = '400x400') {
  const out = path.join(tmpDir, name);
  await runFfmpeg(['-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=s=${size}:d=1:r=10`, out]);
  return out;
}

// Write bytes into a fresh dir and run the generator over them; returns the
// dir's contents so a test can assert "nothing but the original".
async function thumbnail(bytes, filename, opts = BINS) {
  const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
  const src = path.join(outDir, filename);
  await fsp.writeFile(src, bytes);
  await generateThumbnails(bytes, src, outDir, filename, opts);
  return { outDir, entries: fs.readdirSync(outDir).sort() };
}

before(async () => {
  assert.ok(fs.existsSync(FFMPEG), `ffmpeg missing at ${FFMPEG} — copy it from the main checkout`);
  assert.ok(fs.existsSync(FFPROBE), `ffprobe missing at ${FFPROBE} — copy it from the main checkout`);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-imgthumb-'));
  hasWebpEncoder = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/webp/i.test(out)));
  });
});

after(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('dimensionsOf (advisory pre-filter)', () => {
  test('reads JPEG / PNG / GIF header dimensions', async () => {
    for (const [name, size, w, h] of [
      ['a.jpg', '640x480', 640, 480],
      ['a.png', '1234x567', 1234, 567],
      ['a.gif', '321x123', 321, 123],
    ]) {
      const buf = await fsp.readFile(await makeImage(name, size));
      assert.deepEqual(dimensionsOf(buf), { width: w, height: h }, `${name} dimensions`);
    }
  });

  test('reads WebP dimensions from all three fourcc forms (no encoder involved)', () => {
    // VP8 (lossy): the real embedded file.
    assert.deepEqual(dimensionsOf(WEBP_64), { width: 64, height: 64 }, 'VP8 fixture');

    // VP8L (lossless): signature byte + 14-bit (w-1)/(h-1) packed LE.
    const vp8l = Buffer.alloc(5);
    vp8l[0] = 0x2F;
    vp8l.writeUInt32LE((800 - 1) | ((600 - 1) << 14), 1);
    assert.deepEqual(dimensionsOf(craftWebp('VP8L', vp8l)), { width: 800, height: 600 }, 'VP8L header');

    // VP8X (extended): flags + reserved, then 24-bit LE canvas w-1 / h-1.
    const vp8x = Buffer.alloc(10);
    const canvas = (n, off) => { vp8x[off] = (n - 1) & 0xFF; vp8x[off + 1] = ((n - 1) >> 8) & 0xFF; vp8x[off + 2] = ((n - 1) >> 16) & 0xFF; };
    canvas(1920, 4); canvas(1080, 7);
    assert.deepEqual(dimensionsOf(craftWebp('VP8X', vp8x)), { width: 1920, height: 1080 }, 'VP8X header');
  });

  test('walks past a big APPn block to the real frame header', async () => {
    // Marker-chain walking, not a fixed offset: real files carry kilobytes of
    // EXIF/ICC ahead of SOF0.
    const orig = await fsp.readFile(await makeImage('app1-src.jpg', '700x300'));
    const payload = Buffer.alloc(8000, 0x78);
    const seg = Buffer.alloc(4 + payload.length);
    seg[0] = 0xFF; seg[1] = 0xE1;
    seg.writeUInt16BE(payload.length + 2, 2);
    payload.copy(seg, 4);
    const spliced = Buffer.concat([orig.subarray(0, 2), seg, orig.subarray(2)]);
    assert.deepEqual(dimensionsOf(spliced), { width: 700, height: 300 });
  });

  test('returns null for truncated, empty, degenerate and non-image input', () => {
    assert.equal(dimensionsOf(Buffer.from([0xFF, 0xD8, 0xFF])), null, 'truncated JPEG');
    assert.equal(dimensionsOf(Buffer.alloc(0)), null, 'empty');
    assert.equal(dimensionsOf(Buffer.alloc(64, 7)), null, 'garbage');
    assert.equal(dimensionsOf(Buffer.from('this is a text file, not an image')), null, 'text');
    assert.equal(dimensionsOf(null), null, 'null input');
    assert.equal(dimensionsOf(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), null,
      'PNG magic with no IHDR');
  });

  test('terminates promptly on adversarial byte soup', () => {
    // A parser that resynced badly could spin here; the walk is bounded.
    const soup = Buffer.alloc(4 * 1024 * 1024, 0xFF);
    soup[0] = 0xFF; soup[1] = 0xD8;
    const t = Date.now();
    dimensionsOf(soup);
    assert.ok(Date.now() - t < 1000, `walk must not spin (took ${Date.now() - t} ms)`);
  });
});

describe('tooManyPixels + isSupportedImage', () => {
  test('accepts normal art, rejects honestly-oversized art, names the size', async () => {
    const small = await fsp.readFile(await makeImage('small.jpg', '500x500'));
    assert.equal(tooManyPixels(small), null, '0.25 MP is fine');

    const big = await fsp.readFile(await makeImage('big.jpg', '9000x9000'));   // 81 MP
    const reason = tooManyPixels(big);
    assert.ok(reason, '81 MP must be rejected');
    assert.match(reason, /9000×9000/);
    assert.match(reason, /81 MP/);
  });

  test('honours an explicit lower cap', async () => {
    const buf = await fsp.readFile(await makeImage('cap.jpg', '1000x1000'));
    assert.equal(tooManyPixels(buf, 2_000_000), null);
    assert.ok(tooManyPixels(buf, 500_000));
  });

  test('the cap is generous enough for real album art', () => {
    assert.ok(MAX_IMAGE_PIXELS >= 3000 * 3000, 'a 3000×3000 cover must be accepted');
  });

  test('accepts the four supported formats, rejects the rest', async () => {
    for (const name of ['s.jpg', 's.png', 's.gif']) {
      assert.ok(isSupportedImage(await fsp.readFile(await makeImage(name, '64x64'))), `${name} accepted`);
    }
    assert.ok(isSupportedImage(WEBP_64), 'webp accepted (embedded fixture)');
    assert.ok(!isSupportedImage(Buffer.concat([Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.alloc(16)])), 'TIFF');
    assert.ok(!isSupportedImage(Buffer.concat([Buffer.from('BM'), Buffer.alloc(16)])), 'BMP');
    assert.ok(!isSupportedImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])), 'RIFF/AVI');
    assert.ok(!isSupportedImage(Buffer.alloc(4)), 'too short');
  });
});

describe('generateThumbnails — happy paths', () => {
  test('writes both variants, fitting the boxes without upscaling', async () => {
    const src = await makeImage('thumb-src.jpg', '1000x1000');
    const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
    await generateThumbnails(await fsp.readFile(src), src, outDir, 'thumb-src.jpg', BINS);
    const large = path.join(outDir, 'zl-thumb-src.jpg');
    const small = path.join(outDir, 'zs-thumb-src.jpg');
    assert.deepEqual(dimensionsOf(await fsp.readFile(large)), { width: 256, height: 256 });
    assert.deepEqual(dimensionsOf(await fsp.readFile(small)), { width: 92, height: 92 });
    assert.ok(fs.statSync(large).size < fs.statSync(src).size);
  });

  test('a source smaller than the thumbnail box is not upscaled', async () => {
    const src = await makeImage('tiny.jpg', '64x64');
    const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
    await generateThumbnails(await fsp.readFile(src), src, outDir, 'tiny.jpg', BINS);
    assert.deepEqual(dimensionsOf(await fsp.readFile(path.join(outDir, 'zl-tiny.jpg'))),
      { width: 64, height: 64 });
  });

  test('animated inputs yield a single still frame (not an animation)', async () => {
    for (const name of ['anim.gif', 'anim2.gif']) {
      const src = await makeAnimation(name);
      const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
      await generateThumbnails(await fsp.readFile(src), src, outDir, name, BINS);
      const zl = path.join(outDir, 'zl-' + name);
      assert.ok(fs.existsSync(zl), `${name}: zl- written`);
      assert.ok(fs.statSync(zl).size < fs.statSync(src).size, `${name}: smaller than source`);
    }
  });

  test('single-frame GIFs work too (their decoder emits a terminator frame)', async () => {
    const src = await makeImage('still.gif', '400x400');
    const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
    await generateThumbnails(await fsp.readFile(src), src, outDir, 'still.gif', BINS);
    assert.deepEqual(dimensionsOf(await fsp.readFile(path.join(outDir, 'zl-still.gif'))),
      { width: 256, height: 256 });
  });

  test('png cache names produce png thumbnails', async () => {
    const src = await makeImage('c.png', '600x600');
    const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
    await generateThumbnails(await fsp.readFile(src), src, outDir, 'c.png', BINS);
    const zl = await fsp.readFile(path.join(outDir, 'zl-c.png'));
    assert.deepEqual(dimensionsOf(zl), { width: 256, height: 256 }, 'c.png thumbnail readable');
    assert.ok(isSupportedImage(zl), 'c.png thumbnail is a real image');
  });

  test('webp INPUT under a .jpg cache name decodes to jpeg thumbnails', async () => {
    // The upload route names every cache entry <hash>.jpg regardless of
    // content, so a WebP upload is exactly this shape: ffmpeg sniffs the
    // real container, the thumbnails come out JPEG. Needs only the WebP
    // DECODER, which every ffmpeg build carries.
    const { outDir, entries } = await thumbnail(WEBP_64, 'w.jpg');
    assert.deepEqual(entries, ['w.jpg', 'zl-w.jpg', 'zs-w.jpg']);
    const zl = await fsp.readFile(path.join(outDir, 'zl-w.jpg'));
    assert.deepEqual(dimensionsOf(zl), { width: 64, height: 64 }, 'decoded, not upscaled');
  });

  test('webp cache names produce webp thumbnails (when this build can encode them)', async (t) => {
    // Not every ffmpeg build has a WebP ENCODER (macOS CI's homebrew-ffmpeg
    // tap build doesn't). On such hosts .webp-named thumbnail outputs skip
    // gracefully — logged, full-size original still serves — so this pins
    // the encoder path only where the encoder exists.
    if (!hasWebpEncoder) { t.skip('this ffmpeg build has no WebP encoder'); return; }
    const src = await makeImage('c.webp', '600x600');
    const outDir = await fsp.mkdtemp(path.join(tmpDir, 'out-'));
    await generateThumbnails(await fsp.readFile(src), src, outDir, 'c.webp', BINS);
    const zl = await fsp.readFile(path.join(outDir, 'zl-c.webp'));
    assert.deepEqual(dimensionsOf(zl), { width: 256, height: 256 }, 'c.webp thumbnail readable');
    assert.ok(isSupportedImage(zl), 'c.webp thumbnail is a real image');
  });
});

describe('generateThumbnails — never decodes in-process', () => {
  test('no binaries => skipped entirely', async () => {
    const src = await makeImage('noff.jpg', '500x500');
    const { entries } = await thumbnail(await fsp.readFile(src), 'noff.jpg', {});
    assert.deepEqual(entries, ['noff.jpg'], 'nothing written, nothing decoded');
  });

  test('a missing ffmpeg binary => skipped, not decoded', async () => {
    const src = await makeImage('badff.jpg', '400x400');
    const { entries } = await thumbnail(await fsp.readFile(src), 'badff.jpg',
      { ffmpegPath: path.join(tmpDir, 'nope-ffmpeg'), ffprobePath: FFPROBE });
    assert.deepEqual(entries, ['badff.jpg']);
  });

  test('a missing ffprobe binary => skipped (no unverified decode)', async () => {
    const src = await makeImage('badprobe.jpg', '400x400');
    const { entries } = await thumbnail(await fsp.readFile(src), 'badprobe.jpg',
      { ffmpegPath: FFMPEG, ffprobePath: path.join(tmpDir, 'nope-ffprobe') });
    assert.deepEqual(entries, ['badprobe.jpg']);
  });

  test('an honestly-oversized image is skipped before spawning anything', async () => {
    const src = await makeImage('huge.jpg', '9000x9000');
    const { entries } = await thumbnail(await fsp.readFile(src), 'huge.jpg');
    assert.deepEqual(entries, ['huge.jpg']);
  });

  test('a corrupt buffer fails soft (logged, no throw, no output)', async () => {
    const { entries } = await thumbnail(Buffer.alloc(2048, 0x41), 'bogus.jpg');
    assert.deepEqual(entries, ['bogus.jpg']);
  });
});

// ── Adversarial-review regressions: headers that LIE about size ─────────────
//
// Each case below defeated a header-only guard in an earlier revision and
// reinstated a multi-second main-thread stall. With ffprobe as the authority
// and no in-process decoder, each must end in "no thumbnails".

describe('security regressions — lying headers', () => {
  test('GIF claiming a 0×0 logical screen while its frames are huge', async () => {
    const real = await fsp.readFile(await makeImage('lsd-real.gif', '6000x6000'));
    const lying = Buffer.from(real);
    lying.writeUInt16LE(0, 6); lying.writeUInt16LE(0, 8);
    assert.equal(dimensionsOf(lying), null, 'a degenerate size is not a size');
    const { entries } = await thumbnail(lying, 'lying.gif');
    assert.deepEqual(entries, ['lying.gif'], 'a lying header must not buy a decode');
  });

  test('JPEG hiding a gigapixel frame after the first scan', async () => {
    // Round-1 fix walked to the largest SOF but stopped at SOS; round 2 hid
    // the payload after it. The walk now skips entropy-coded data.
    const small = await fsp.readFile(await makeImage('two-small.jpg', '16x16'));
    const big = await fsp.readFile(await makeImage('two-big.jpg', '9000x9000'));
    const concat = Buffer.concat([small.subarray(0, small.length - 2), big.subarray(2)]);
    const dim = dimensionsOf(concat);
    assert.ok(dim && dim.width === 9000 && dim.height === 9000,
      `must see the hidden frame, got ${JSON.stringify(dim)}`);
    assert.ok(tooManyPixels(concat), 'and reject it');
  });

  test('JPEG with a decoy 1×1 frame in front of the real one', async () => {
    const real = await fsp.readFile(await makeImage('decoy-real.jpg', '9000x9000'));
    const decoy = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    const spliced = Buffer.concat([real.subarray(0, 2), decoy, real.subarray(2)]);
    assert.deepEqual(dimensionsOf(spliced), { width: 9000, height: 9000 },
      'report the LARGEST frame, not the first');
    const { entries } = await thumbnail(spliced, 'decoy.jpg');
    assert.deepEqual(entries, ['decoy.jpg']);
  });

  test('PNG with a decoy chunk before IHDR', async () => {
    const real = await fsp.readFile(await makeImage('png-real.png', '3000x3000'));
    const decoy = Buffer.alloc(25);
    decoy.writeUInt32BE(13, 0);
    decoy.write('nOTi', 4, 'latin1');
    decoy.writeUInt32BE(1, 8); decoy.writeUInt32BE(1, 12);
    const spliced = Buffer.concat([real.subarray(0, 8), decoy, real.subarray(8)]);
    assert.equal(dimensionsOf(spliced), null,
      'IHDR-not-first reads as unknown, never as the decoy size');
  });

  test('an unreadable-but-plausible file is skipped rather than decoded', async () => {
    // Valid GIF magic, nothing behind it: ffprobe finds no image stream.
    const bytes = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4096, 0x33)]);
    const { entries } = await thumbnail(bytes, 'fake.gif');
    assert.deepEqual(entries, ['fake.gif']);
  });
});
