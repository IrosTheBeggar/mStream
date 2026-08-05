// Album-art thumbnail generation.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// Untrusted image bytes are NEVER decoded in this process. Thumbnails are
// produced by the bundled ffmpeg in a child process, or not at all.
//
// WHY (2026-07 audit finding H1 + two rounds of adversarial review): thumbnails
// used to be produced with Jimp, a pure-JS decoder, directly on the event loop.
// The routes cap bytes (10 MB) but bytes do not bound DECODE cost, so any
// authenticated user could upload a small file that decoded huge and stalled
// the whole server (measured: 2.3 s of blocked event loop from a 92 KB
// 4000×4000 JPEG; every other request waits behind it).
//
// The obvious fix — read the dimensions from the header and refuse big images —
// DOES NOT WORK, and the review proved it four separate ways. Every format can
// lie about its size in a way the decoder ignores but a header parser believes:
//   • JPEG   — extra frames after the first scan (a parser that stops at SOS
//              sees a 16×16 decoy; jpeg-js decodes the hidden 9000×9000 frame)
//   • PNG    — decoy chunks ahead of IHDR; and INTERLACED IDAT is inflated
//              without a length cap by pngjs (1.5 MB → 1500 MB, 2.5 GB RSS)
//   • GIF    — the logical-screen descriptor can claim 0×0 or 1×1 while the
//              frame descriptors that actually drive LZW decoding are huge
//   • WebP   — the VP8X canvas field is independent of the coded sub-chunk
// Each bypass reinstated multi-second main-thread stalls from KB-sized files.
// There is no header-parsing fix for this: the cost lives in data the header
// does not honestly describe. So the pure-JS decoder is gone from this path
// entirely — that is the only bound that holds.
//
// Consequences, deliberately accepted:
//   • No ffmpeg → no thumbnails. The full-size original still serves (the
//     ?compress= handler falls through to it), so the feature degrades to
//     "bigger images", not "broken images". Hosts without ffmpeg already lack
//     transcoding, waveforms and audio analysis.
//   • Dimensions still get checked twice, but as CHEAP PRE-FILTERS, not as the
//     security boundary: the header sniff below rejects honest oversized
//     uploads instantly, and ffprobe — a real parser, in a child process —
//     is the authority that gates the decode.
//
// `sharp` is deliberately not used: it is only present transitively via the
// OPTIONAL @huggingface/transformers dependency, so installs that skipped
// optional deps (or where its native build failed — musl, small VPSes) would
// lose album-art processing entirely. ffmpeg is already first-class here.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import winston from 'winston';
import { ffmpegBin, ffprobeBin } from './ffmpeg-bootstrap.js';

// What we accept at all. 4900×4900 is already far past any real cover; this
// bounds the work the ffmpeg child can be asked to do.
export const MAX_IMAGE_PIXELS = 24_000_000;   // 24 MP

const THUMB_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;

// Bounded concurrency: each request would otherwise spawn its own ffmpeg, so
// N uploads = N decoders competing for the box (the sibling waveform endpoint
// caps the same way). Excess callers wait; the queue drains as children exit.
const MAX_CONCURRENT_THUMBS = 2;
let activeThumbs = 0;
const thumbWaiters = [];
function acquireSlot() {
  if (activeThumbs < MAX_CONCURRENT_THUMBS) { activeThumbs++; return Promise.resolve(); }
  return new Promise((resolve) => { thumbWaiters.push(resolve); });
}
function releaseSlot() {
  const next = thumbWaiters.shift();
  if (next) { next(); return; }         // hands the slot straight over
  activeThumbs--;
}

/**
 * Header dimension sniff for JPEG/PNG/WebP/GIF.
 *
 * ⚠ ADVISORY ONLY — a fast pre-filter for honest files, NEVER a security
 * boundary. See the header comment: every one of these formats can carry a
 * header that disagrees with what a decoder actually does. Use it to reject
 * obviously-oversized uploads early (and to give the user a clear message);
 * never use it to decide that decoding something is safe.
 *
 * @returns {{width:number,height:number}|null} null when unrecognised,
 *   truncated, or degenerate (a 0 dimension) — callers treat null as "unknown".
 */
export function dimensionsOf(buf) {
  if (!buf || buf.length < 16) { return null; }
  const ok = (w, h) => (w > 0 && h > 0 ? { width: w, height: h } : null);

  // PNG: IHDR must be the FIRST chunk (spec) — verify the chunk type rather
  // than trusting fixed offsets, so a decoy chunk can't shift what we read.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24 || buf.slice(12, 16).toString('latin1') !== 'IHDR') { return null; }
    return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  }

  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  }

  if (buf.slice(0, 4).toString('latin1') === 'RIFF'
    && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const fourcc = buf.slice(12, 16).toString('latin1');
    if (fourcc === 'VP8 ' && buf.length >= 30) {
      return ok(buf.readUInt16LE(26) & 0x3FFF, buf.readUInt16LE(28) & 0x3FFF);
    }
    if (fourcc === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return ok((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1);
    }
    if (fourcc === 'VP8X' && buf.length >= 30) {
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return ok(w + 1, h + 1);
    }
    return null;
  }

  // JPEG: walk the marker chain, reporting the LARGEST frame header seen.
  // Frames can also appear after the first scan, so the walk continues past
  // SOS by skipping entropy-coded data (any 0xFF byte followed by 0x00 or a
  // restart marker is image data, not a marker).
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    let best = null;
    let guard = 0;
    while (i + 9 < buf.length && guard++ < 100_000) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xFF || marker === 0x00) { i++; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (marker === 0xD9) { break; }                       // EOI
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) { i += 2; continue; }                    // malformed — resync
      const isSof = (marker >= 0xC0 && marker <= 0xCF)
        && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof && i + 9 < buf.length) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        if (w > 0 && h > 0 && (!best || w * h > best.width * best.height)) { best = { width: w, height: h }; }
      }
      if (marker === 0xDA) {
        // Skip the entropy-coded segment: scan forward to the next real
        // marker so frames hidden AFTER this scan are still counted.
        let j = i + 2 + len;
        while (j + 1 < buf.length) {
          if (buf[j] === 0xFF && buf[j + 1] !== 0x00
            && !(buf[j + 1] >= 0xD0 && buf[j + 1] <= 0xD7)) { break; }
          j++;
        }
        i = j;
        continue;
      }
      i += 2 + len;
    }
    return best;
  }

  return null;
}

/**
 * Magic-byte format check for the formats the album-art paths support.
 * Shared by every entry point so they cannot drift apart.
 */
export function isSupportedImage(buf) {
  if (!buf || buf.length < 12) { return false; }
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const isWebp = buf.slice(0, 4).toString('latin1') === 'RIFF'
    && buf.slice(8, 12).toString('latin1') === 'WEBP';
  const isGif = buf.slice(0, 3).toString('latin1') === 'GIF';
  return isJpeg || isPng || isWebp || isGif;
}

/**
 * Cheap pre-filter: reject obviously-oversized uploads with a clear message.
 * Returns null (accept) or a human-readable reason. Unknown/lying headers pass
 * — ffprobe is what actually gates the decode.
 */
export function tooManyPixels(buf, maxPixels = MAX_IMAGE_PIXELS) {
  const dim = dimensionsOf(buf);
  if (!dim) { return null; }
  const pixels = dim.width * dim.height;
  if (pixels <= maxPixels) { return null; }
  return `image is ${dim.width}×${dim.height} (${Math.round(pixels / 1e6)} MP); `
    + `the limit is ${Math.round(maxPixels / 1e6)} MP`;
}

function runChild(bin, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_e) { /* already gone */ }
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { return resolve(stdout); }
      reject(new Error(`${label} exited ${code}: ${stderr.trim().slice(-200)}`));
    });
  });
}

/**
 * AUTHORITATIVE dimensions, via ffprobe in a child process — a real parser
 * reading the real stream, so the header lies that defeat dimensionsOf() do
 * not apply. Returns null when ffprobe can't tell us (unreadable file, no
 * video stream), which callers treat as "don't decode it".
 */
async function probeDimensions(ffprobe, srcPath) {
  const out = await runChild(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', srcPath,
  ], PROBE_TIMEOUT_MS, 'ffprobe');
  const m = /^(\d+)x(\d+)/m.exec(out.trim());
  if (!m) { return null; }
  const width = Number(m[1]);
  const height = Number(m[2]);
  return (width > 0 && height > 0) ? { width, height } : null;
}

// `-frames:v 1` per output is load-bearing: without it a multi-frame input
// (every GIF — even single-frame ones, whose decoder emits a terminator —
// plus APNG and animated WebP) makes the image2 muxer abort, and it also
// guarantees a still thumbnail rather than an animated one larger than the
// source. `-threads 1` keeps one upload from claiming every core.
function ffmpegThumbnails(ffmpeg, srcPath, outLarge, outSmall) {
  return runChild(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1',
    '-i', srcPath,
    '-frames:v', '1',
    '-vf', "scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '4', outLarge,
    '-frames:v', '1',
    '-vf', "scale='min(92,iw)':'min(92,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '4', outSmall,
  ], THUMB_TIMEOUT_MS, 'ffmpeg thumbnail');
}

/**
 * Write the zl-/zs- thumbnail variants for an image already cached at
 * `srcPath`. Best-effort by contract: the full-size original serves fine on
 * its own, so every failure is logged and swallowed rather than failing the
 * caller's request. Never decodes in-process (see the header comment).
 *
 * @param {Buffer} imgBuf    image bytes — used only for the cheap pre-filter
 * @param {string} srcPath   path the original was just written to
 * @param {string} outDir    album-art cache directory
 * @param {string} filename  cache filename; variants get zl-/zs- prefixes
 * @param {object} [opts]
 * @param {number} [opts.maxPixels]
 * @param {string} [opts.ffmpegPath]   explicit binaries, for callers without
 * @param {string} [opts.ffprobePath]  config state (forked workers) and tests
 */
export async function generateThumbnails(imgBuf, srcPath, outDir, filename, opts = {}) {
  const { maxPixels = MAX_IMAGE_PIXELS } = opts;
  const ffmpeg = opts.ffmpegPath || ffmpegBin();
  const ffprobe = opts.ffprobePath || ffprobeBin();

  if (!ffmpeg || !ffprobe) {
    winston.warn(`album-art thumbnails skipped for ${filename}: ffmpeg/ffprobe unavailable `
      + `(the full-size image still serves; in-process decoding is deliberately not a fallback)`);
    return;
  }
  for (const bin of [ffmpeg, ffprobe]) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
      winston.warn(`album-art thumbnails skipped for ${filename}: '${bin}' is missing`);
      return;
    }
  }

  // Cheap pre-filter on the header — rejects honest oversized files without
  // spawning anything. Not trusted for the accept decision (ffprobe is).
  const headerReason = tooManyPixels(imgBuf, maxPixels);
  if (headerReason) {
    winston.warn(`album-art thumbnails skipped for ${filename}: ${headerReason}`);
    return;
  }

  await acquireSlot();
  try {
    let dim;
    try {
      dim = await probeDimensions(ffprobe, srcPath);
    } catch (err) {
      winston.warn(`album-art thumbnails skipped for ${filename}: ffprobe failed (${err.message})`);
      return;
    }
    if (!dim) {
      winston.warn(`album-art thumbnails skipped for ${filename}: no readable image stream`);
      return;
    }
    if (dim.width * dim.height > maxPixels) {
      winston.warn(`album-art thumbnails skipped for ${filename}: ffprobe reports `
        + `${dim.width}×${dim.height} (${Math.round(dim.width * dim.height / 1e6)} MP), `
        + `over the ${Math.round(maxPixels / 1e6)} MP limit`);
      return;
    }
    try {
      await ffmpegThumbnails(ffmpeg, srcPath, outLargePath(outDir, filename), outSmallPath(outDir, filename));
    } catch (err) {
      winston.warn(`album-art thumbnails failed for ${filename}: ${err.message}`);
    }
  } finally {
    releaseSlot();
  }
}

function outLargePath(outDir, filename) { return path.join(outDir, 'zl-' + filename); }
function outSmallPath(outDir, filename) { return path.join(outDir, 'zs-' + filename); }
