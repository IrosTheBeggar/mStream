// Waveform generation helpers for the on-demand fallback path.
//
// The primary generator is the post-scan `rust-parser --waveform-scan`
// pass (symphonia-based, writes .bin files keyed by content hash). This
// module backs the on-demand endpoint (src/api/waveform.js) for tracks
// the pass can't or hasn't covered — Opus (symphonia 0.5 has no
// decoder), files played before the pass reaches them, or hosts with no
// rust binary. It spawns ffmpeg and decodes to mono 8-bit unsigned PCM
// at 8 kHz; pcm_u8 encodes silence as 128, so magnitude is |sample-128|
// (0..127), rescaled to 0..255. The cache format is shared with the
// rust pass, .failed markers included.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const NUM_BARS = 800;

// On-disk cache format: raw byte array, exactly NUM_BARS bytes, one per bar.
// Files are keyed by track content hash. Exported (with failedMarkerPath
// below) so the naming scheme has ONE owner — the V59 hash-transition
// applier renames these artifacts when a track's canonical hash changes.
const CACHE_EXT = '.bin';

export function cacheFilePath(dir, fileHash) {
  return path.join(dir, fileHash + CACHE_EXT);
}

/**
 * Read a cached waveform. Returns null if nothing is cached OR the file
 * exists but isn't exactly NUM_BARS bytes (partial write from a prior
 * crash, wrong-format leftover, etc.) — in which case the caller
 * regenerates, so the corrupt cache file self-heals next time.
 */
export async function readCachedWaveform(dir, fileHash) {
  let buf;
  try {
    buf = await fsp.readFile(cacheFilePath(dir, fileHash));
  } catch (err) {
    if (err.code === 'ENOENT') { return null; }
    throw err;
  }
  if (buf.length !== NUM_BARS) { return null; }
  return Array.from(buf);
}

/**
 * Write a cached waveform atomically: write to a sibling `.bin.tmp`, then
 * rename to `.bin`. Prevents partial writes from a process crash or
 * power-loss leaving a truncated file that `readCachedWaveform` would see
 * as valid. Mirrors the atomic-write pattern the Rust scanner uses on the
 * scan path.
 *
 * Values outside [0, 255] are masked to 8 bits by Buffer.from — shouldn't
 * happen given generateWaveformBars() clamps on output, but the clamp is
 * implicit rather than asserted.
 */
export async function writeCachedWaveform(dir, fileHash, bars) {
  const finalPath = cacheFilePath(dir, fileHash);
  const tmpPath = path.join(dir, fileHash + CACHE_EXT + '.tmp');
  await fsp.writeFile(tmpPath, Buffer.from(bars));
  await fsp.rename(tmpPath, finalPath);
}

// Failure markers, shared with the rust `--waveform-scan` pass: a
// `<hash>.failed` file whose lines name the engines that failed on this
// content. The pass records `symphonia` and skips marked hashes; the
// endpoint here only respects the `ffmpeg` line (ffmpeg decodes formats
// symphonia can't — Opus — so a symphonia failure must not block us).
// A successful generation deletes the marker.

export function failedMarkerPath(dir, fileHash) {
  return path.join(dir, fileHash + '.failed');
}

export function hasFfmpegFailedMarker(dir, fileHash) {
  try {
    return fs.readFileSync(failedMarkerPath(dir, fileHash), 'utf8').includes('ffmpeg');
  } catch (_err) {
    return false;
  }
}

export async function recordFfmpegFailure(dir, fileHash) {
  try { await fsp.appendFile(failedMarkerPath(dir, fileHash), 'ffmpeg\n'); }
  catch (_err) { /* marker is advisory — never fail the request over it */ }
}

export async function clearFailedMarker(dir, fileHash) {
  try { await fsp.unlink(failedMarkerPath(dir, fileHash)); }
  catch (_err) { /* none existed */ }
}

const FFMPEG_TIMEOUT = 30000;       // per track
const SIGKILL_GRACE = 5000;         // SIGTERM → SIGKILL escalation window

// Streaming peak accumulator with a bounded footprint. PCM length isn't
// known up front (no ffprobe round-trip), so bars can't be binned as
// bytes arrive — and buffering everything caps the track length (the old
// 2 MB buffer silently truncated anything past ~262s at 8 kHz and wrote
// the WRONG waveform to the shared cache). Instead: store one peak per
// `stride` samples; when storage fills, halve it in place (peak of
// pairs) and double the stride. Peaks-of-peaks stay exact, memory never
// exceeds CAPACITY bytes, and any track length bins correctly at the end.
const CAPACITY = 1 << 20;  // 1 MiB of peaks ≈ 131s at stride 1; 10h track → stride 32
class PeakPyramid {
  constructor() {
    this.store = new Uint8Array(CAPACITY);
    this.length = 0;       // groups stored
    this.stride = 1;       // raw samples per group
    this.groupPeak = 0;    // current partial group
    this.groupFill = 0;
  }

  push(pcmChunk) {
    for (let i = 0; i < pcmChunk.length; i++) {
      const v = pcmChunk[i] - 128;             // deviation from u8 silence
      const mag = v < 0 ? -v : v;              // |v| in [0, 128]
      if (mag > this.groupPeak) { this.groupPeak = mag; }
      if (++this.groupFill === this.stride) {
        if (this.length === CAPACITY) {
          for (let j = 0; j < CAPACITY / 2; j++) {
            this.store[j] = Math.max(this.store[2 * j], this.store[2 * j + 1]);
          }
          this.length = CAPACITY / 2;
          this.stride *= 2;
          // The partial group keeps filling under the doubled stride.
          continue;
        }
        this.store[this.length++] = this.groupPeak;
        this.groupPeak = 0;
        this.groupFill = 0;
      }
    }
  }

  bars(numBars) {
    // Flush the partial tail group; when storage is exactly full, merge
    // it into the last group instead of dropping those samples.
    if (this.groupFill > 0) {
      if (this.length < CAPACITY) {
        this.store[this.length++] = this.groupPeak;
      } else if (this.groupPeak > this.store[CAPACITY - 1]) {
        this.store[CAPACITY - 1] = this.groupPeak;
      }
      this.groupPeak = 0;
      this.groupFill = 0;
    }
    const total = this.length;
    if (total === 0) { return null; }
    const bars = new Array(numBars);
    for (let i = 0; i < numBars; i++) {
      const start = Math.floor(i * total / numBars);
      const end = Math.floor((i + 1) * total / numBars);
      let peak = 0;
      for (let j = start; j < end; j++) {
        if (this.store[j] > peak) { peak = this.store[j]; }
      }
      bars[i] = Math.min(255, peak * 2);            // rescale to [0, 255]
    }
    return bars;
  }
}

/**
 * Generate waveform bars for an audio file.
 * @param {string} audioPath  absolute path to audio file
 * @param {string} ffmpegBin  path or command name for ffmpeg
 * @returns {Promise<number[]>} NUM_BARS entries in [0, 255]
 */
export function generateWaveformBars(audioPath, ffmpegBin) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Cap internal threads to 1 — the endpoint's semaphore already
      // bounds concurrency; extra threads per process just fight for cores.
      '-threads', '1',
      '-i', audioPath,
      // Drop embedded cover art / data / subtitle streams so ffmpeg doesn't
      // waste cycles decoding a JPEG we'd discard anyway.
      '-vn', '-dn', '-sn',
      '-ac', '1',                // mono
      '-ar', '8000',             // 8 kHz — plenty of resolution for 800 bars
      '-f', 'u8',
      '-acodec', 'pcm_u8',
      'pipe:1'
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const pyramid = new PeakPyramid();
    let killTimer = null;

    proc.stdout.on('data', (chunk) => pyramid.push(chunk));

    // Transient failures (timeout under load, spawn errors) must NOT be
    // remembered in a .failed marker — only verdicts ffmpeg itself
    // renders about the content. The caller checks this flag.
    const transient = (msg) => {
      const err = new Error(msg);
      err.transient = true;
      return err;
    };

    const timer = setTimeout(() => {
      // SIGTERM first; ffmpeg blocked in uninterruptible I/O can shrug
      // it off, so escalate — an orphaned decoder pinned at 100% CPU is
      // worse than a clipped request.
      try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, SIGKILL_GRACE);
      reject(transient('ffmpeg timeout'));
    }, FFMPEG_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); }
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const bars = pyramid.bars(NUM_BARS);
      if (!bars) {
        return reject(new Error('ffmpeg produced no audio data'));
      }
      resolve(bars);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); }
      err.transient = true; // exec failure says nothing about the content
      reject(err);
    });
  });
}
