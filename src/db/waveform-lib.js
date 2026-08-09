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

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const NUM_BARS = 800;

// On-disk cache format: raw byte array, exactly NUM_BARS bytes, one per bar.
// Files are keyed by track content hash. Exported (with failedMarkerPath
// below) so the naming scheme has ONE owner — the V60 hash-transition
// applier renames these artifacts when a track's canonical hash changes,
// and the rust pass mirrors these constants (WAVEFORM_EXT in main.rs).
//
// The `w2` generation marks a decoder correctness fix: bars are binned by
// the frames actually decoded rather than a container-declared length, and
// channels combine with max|ch| rather than an average or a mono sum. The
// same audio therefore produces different bytes than v1 did, so v1 names
// are neither read nor honoured — sweepSupersededArtifacts() deletes them
// and both engines regenerate.
//
// Bump this whenever the bars change meaning, and bump `_WF_LS_PREFIX` in
// webapp/alpha/vp.js with it: browsers keep their own copy keyed by
// filepath with no version in the value, so a server-side change that
// doesn't move that prefix never reaches anyone who already played the
// track. Exported because the coverage counter matches names rather than
// building paths.
export const CACHE_EXT = '.w2.bin';
export const FAILED_EXT = '.w2.failed';

// Third artifact: the rust pass DEFERRED this key to the ffmpeg half —
// it has no decoder for the codec (Opus in any container, 5.1/HE-AAC in
// .m4a/.m4b/.aac, anything else symphonia's registry can't instantiate).
//
// Deliberately a separate suffix rather than a line inside `.failed`.
// Everything that classifies these artifacts does so by FILENAME —
// notably the enrichment coverage counter, which must stay filename-only
// (it is the hot status path behind a prior production CPU-spin
// incident, so it must never read N marker bodies per poll). Folding the
// deferral into `.failed` made a perfectly good file count as a decode
// FAILURE in the admin panel, which is the exact misreport this whole
// pass exists to remove.
export const DEFERRED_EXT = '.w2.deferred';

export function cacheFilePath(dir, fileHash) {
  return path.join(dir, fileHash + CACHE_EXT);
}

/**
 * Ask a rust-parser binary which cache generation it writes. The server
 * refuses to run the waveform pass when this differs from CACHE_EXT: a
 * binary one generation behind would write names the boot sweep deletes,
 * re-decoding the whole library on every boot — the exact cycle a stale
 * local `rust-parser/target` build (or the bin/ prebuilts in the window
 * before CI rebuilds them) would otherwise cause.
 *
 * @returns {string|null} the binary's waveform extension, or null when the
 *   binary pre-dates the probe or failed to answer
 */
export function probeWaveformGeneration(rustBin) {
  try {
    const r = spawnSync(rustBin, ['--wf-generation'], { encoding: 'utf8', timeout: 5000 });
    const parsed = JSON.parse(String(r.stdout || '').trim());
    return typeof parsed.waveformExt === 'string' ? parsed.waveformExt : null;
  } catch (_err) {
    return null;   // pre-probe binary: "Invalid JSON Input" on stderr, empty stdout
  }
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
// Per-writer temp sequence. The staging name must be unique per write:
// with a fixed name, two same-key writers (the on-demand endpoint and the
// fallback pass live in one process but there can be a second mStream
// against the same cache dir) interleave write/rename and the loser's
// rename throws ENOENT. The rust side solved this the same way
// (write_atomic's `<file>.tmp.<seq>`), and its stale-temp sweep collects
// any `.tmp.` leftovers older than an hour, which this name shape joins.
let wfTmpSeq = 0;

export async function writeCachedWaveform(dir, fileHash, bars) {
  const finalPath = cacheFilePath(dir, fileHash);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${wfTmpSeq++}`;
  try {
    await fsp.writeFile(tmpPath, Buffer.from(bars));
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    fsp.unlink(tmpPath).catch(() => {});   // don't orphan the staging file
    throw err;
  }
}

// Failure markers, shared with the rust `--waveform-scan` pass: a
// `<hash>.failed` file whose lines name the engines that failed on this
// content. The pass records `symphonia` and skips marked hashes; the
// endpoint here only respects the `ffmpeg` line (ffmpeg decodes formats
// symphonia can't — Opus — so a symphonia failure must not block us).
// A successful generation deletes the marker.

export function failedMarkerPath(dir, fileHash) {
  return path.join(dir, fileHash + FAILED_EXT);
}

export function deferredMarkerPath(dir, fileHash) {
  return path.join(dir, fileHash + DEFERRED_EXT);
}

/**
 * Delete cache artifacts left by an older bar format. Called once per boot
 * from the endpoint's ensureCacheDir(), which is the only place both the
 * rust-equipped and rust-less deployments pass through — putting it in the
 * rust pass would strand the sweep on hosts that never run one.
 *
 * Without this the old files are merely ignored, which is worse than it
 * sounds: the enrichment coverage counter would keep counting them, and on
 * a large library they are dead weight (one 800-byte file per track) that
 * nothing would ever clean up. Best-effort throughout — a cache directory
 * we cannot write is already handled as advisory.
 *
 * @returns {Promise<number>} artifacts removed
 */
export async function sweepSupersededArtifacts(dir) {
  let names;
  try { names = await fsp.readdir(dir); }
  catch (_err) { return 0; }   // no dir yet, or unreadable — nothing to do

  // Only names WE could have written are candidates: a bare content hash
  // (lowercase hex, 32 for MD5 today, room for longer digests) directly
  // followed by the artifact suffix. The directory is operator-pointable
  // (storage.waveformCacheDirectory is a free-form string), and `.bin` is
  // not ours alone — cue/bin disc images live in real music libraries,
  // and ML tooling ships pytorch_model.bin. A suffix-only match deleted
  // all of those; a hash-shaped name that ISN'T ours is indistinguishable
  // anyway, which is as narrow as this can get.
  const V1_ARTIFACT = /^[0-9a-f]{32,64}\.(bin|failed|deferred)$/;
  const stale = names.filter((n) =>
    V1_ARTIFACT.test(n)
    && !n.endsWith(CACHE_EXT) && !n.endsWith(FAILED_EXT) && !n.endsWith(DEFERRED_EXT));

  let removed = 0;
  const BATCH = 32;
  for (let i = 0; i < stale.length; i += BATCH) {
    await Promise.all(stale.slice(i, i + BATCH).map(async (name) => {
      try { await fsp.unlink(path.join(dir, name)); removed++; }
      catch (_err) { /* raced with another sweep, or read-only cache */ }
    }));
  }
  return removed;
}

export function hasFfmpegFailedMarker(dir, fileHash) {
  try {
    return fs.readFileSync(failedMarkerPath(dir, fileHash), 'utf8').includes('ffmpeg');
  } catch (_err) {
    return false;
  }
}

/**
 * Record ffmpeg's failure verdict on a content key.
 *
 * @returns {Promise<boolean>} whether the marker actually landed on disk.
 *   The write error itself stays swallowed (the marker is advisory — never
 *   fail a request over it), but callers that count failures as PROGRESS
 *   must know the difference: the fallback pass re-enqueues itself on the
 *   promise that every counted failure shrank the next plan, and a marker
 *   that never landed shrinks nothing.
 */
export async function recordFfmpegFailure(dir, fileHash) {
  try {
    await fsp.appendFile(failedMarkerPath(dir, fileHash), 'ffmpeg\n');
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Drop every marker for a key. Called when a waveform is successfully
 * generated: both a failure verdict and a deferral are now false, and a
 * stale deferral would keep the key in the fallback's plan forever.
 */
export async function clearWaveformMarkers(dir, fileHash) {
  await Promise.all([
    fsp.unlink(failedMarkerPath(dir, fileHash)).catch(() => {}),
    fsp.unlink(deferredMarkerPath(dir, fileHash)).catch(() => {}),
  ]);
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
      // A clip with fewer than numBars groups would otherwise leave empty
      // bars interleaved with filled ones; neighbours share a group
      // instead. Matches PeakPyramid::bars() in rust-parser.
      const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * total / numBars)));
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
      // Deliberately NO `-ac 1`. Downmixing to mono SUMS the channels, so
      // anything out of phase between them cancels: an anti-phase stereo
      // fixture that the rust engine renders at 32/255 across the whole
      // file came back from here as 800 zero bars — a blank waveform for
      // audio that is plainly audible. Real mid/side-widened masters lose
      // energy the same way, just partially.
      //
      // Keeping the channels interleaved costs nothing here: the pyramid
      // takes a running max over every sample it is handed, and max over
      // (channels x time) is exactly max-per-frame then max-over-time.
      // That matches the rust engine's reduction ON THE CHANNEL AXIS —
      // the two engines are NOT byte-identical, because `-ar 8000` below
      // band-limits this path to 4 kHz while rust decodes at native rate,
      // so bright broadband content reads somewhat lower here (measured
      // 0.84-0.98x on real music). Only ever visible across a cache
      // regeneration; the player shows one engine's bars at a time.
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
