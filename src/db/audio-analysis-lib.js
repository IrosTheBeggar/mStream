// Audio-analysis helpers: decode an audio file to mono float PCM via ffmpeg,
// then estimate BPM + musical key with essentia.js (a WASM build of the
// Essentia C++ library).
//
// This is the CPU core of the post-scan "essentia enrichment" pass
// (the analysis counterpart to album-art-backfill.mjs). It populates the
// tracks.bpm / musical_key columns (V32) for files whose tags carried no
// BPM/key, so the Auto-DJ BPM-continuity / harmonic-mixing waterfall in
// src/api/random.js has data to work with.
//
// Decode mirrors src/db/waveform-lib.js (same bundled ffmpeg, same -vn/-dn/-sn
// stream-drop, same spawn-with-timeout shape) but emits 32-bit float PCM at
// 44.1 kHz mono — the sample rate Essentia's RhythmExtractor2013 / KeyExtractor
// default to — instead of the waveform path's 8 kHz u8.
//
// LICENSE NOTE: essentia.js is AGPL-3.0 (it embeds the AGPL Essentia C++
// backend). mStream is GPL-3.0; AGPL's network-use clause is a deliberate
// decision for the project owner to make before this ships. Kept isolated in
// this module + the forked worker so it's a clean unit to gate behind a config
// flag (and to remove if the licensing tradeoff isn't wanted).

import { spawn } from 'node:child_process';

// Essentia's algorithms default to this rate; decode to match so we never
// pass a `sampleRate` override into the WASM calls.
export const ANALYSIS_SAMPLE_RATE = 44100;

// Whole-file decode (analysis needs every sample, unlike the streaming
// waveform binner). A long file can't be allowed to balloon memory: 44.1k
// f32 mono is 176 KB/s, so 10 min ≈ 103 MB, 30 min ≈ 310 MB. We hard-cap the
// decoded span with ffmpeg's `-t`; the post-scan pass also pre-filters to a
// duration window, so this is a defensive ceiling, not the primary gate.
const DEFAULT_MAX_SECONDS = 600;     // analyse at most the first 10 minutes
const DEFAULT_DECODE_TIMEOUT_MS = 120000;
const SIGKILL_GRACE = 5000;

// Tag-path BPM sanity range (matches scanner.mjs's TBPM validation) — an
// estimate outside this is treated as a non-result.
const MIN_BPM = 20;
const MAX_BPM = 300;

// ── essentia.js loader (cached singleton) ────────────────────────────────────
//
// Runtime-switched, mirroring src/db/sqlite-driver.js. The package's index.js
// require()s add-on modules (model/extractor/plot) absent from the 0.1.3
// tarball, so `require('essentia.js')` throws — we load the two dist files we
// actually need directly.
//   - Node/Electron (the shipped runtime, verified): require() the .umd builds.
//     The umd WASM embeds the binary and instantiates synchronously.
//   - Bun --compile standalone: createRequire can't resolve node_modules inside
//     the binary, so we use static-literal dynamic imports of the .es builds,
//     which Bun's bundler embeds (same reason maybeRunWorker uses static
//     import()). The Bun build is an unshipped spike, so this branch is
//     best-effort; the Node branch is the tested path.
// Async so the Bun dynamic import can be awaited; callers `await getEssentia()`.

let _essentia = null;
export async function getEssentia() {
  if (_essentia) { return _essentia; }
  let EssentiaWASM, Essentia;
  if (globalThis.Bun) {
    const wasmMod = await import('essentia.js/dist/essentia-wasm.es.js');
    const coreMod = await import('essentia.js/dist/essentia.js-core.es.js');
    EssentiaWASM = wasmMod.EssentiaWASM || wasmMod.default || wasmMod;
    Essentia = coreMod.default || coreMod.Essentia || coreMod;
  } else {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const wasmMod = require('essentia.js/dist/essentia-wasm.umd.js');
    const coreMod = require('essentia.js/dist/essentia.js-core.umd.js');
    EssentiaWASM = wasmMod.EssentiaWASM || wasmMod;
    Essentia = coreMod.Essentia || coreMod.default || coreMod;
  }
  _essentia = new Essentia(EssentiaWASM);
  return _essentia;
}

// ── Decode ───────────────────────────────────────────────────────────────────

/**
 * Decode an audio file to a mono Float32Array via ffmpeg.
 *
 * @param {string} audioPath  absolute path to the audio file
 * @param {string} ffmpegBin  path or command name for ffmpeg
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {number} [opts.maxSeconds=600]   cap decoded span (memory/time guard)
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Promise<Float32Array>} mono PCM samples in [-1, 1]
 *
 * Rejected errors carry `.transient = true` for failures that say nothing
 * about the content (spawn error, timeout) so the caller's negative cache can
 * distinguish "retry later" from "this file is undecodable here" — same
 * convention as waveform-lib.js.
 */
export function decodePcmF32(audioPath, ffmpegBin, opts = {}) {
  const sampleRate = opts.sampleRate || ANALYSIS_SAMPLE_RATE;
  const maxSeconds = opts.maxSeconds || DEFAULT_MAX_SECONDS;
  const timeoutMs = opts.timeoutMs || DEFAULT_DECODE_TIMEOUT_MS;
  // Optional input seek: decode a window starting at seekSec instead of the
  // whole file. `-ss` BEFORE `-i` = fast container-level seek — how the
  // discovery embedder grabs its 10 s analysis windows without decoding
  // whole tracks. Seek granularity is codec-dependent (a window may start a
  // few hundred ms off the requested position), which is fine for analysis
  // windows but would NOT be fine for gapless/precise extraction.
  const seekSec = opts.seekSec;

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '1',
      ...(seekSec != null ? ['-ss', String(seekSec)] : []),
      '-t', String(maxSeconds),   // before -i: limit decoded output duration
      '-i', audioPath,
      '-vn', '-dn', '-sn',        // drop cover art / data / subtitle streams
      '-ac', '1',                 // mono
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let nbytes = 0;
    let killTimer = null;

    const transient = (msg) => {
      const err = new Error(msg);
      err.transient = true;
      return err;
    };

    proc.stdout.on('data', (c) => { chunks.push(c); nbytes += c.length; });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, SIGKILL_GRACE);
      reject(transient('ffmpeg decode timeout'));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); }
      if (code !== 0) { return reject(new Error(`ffmpeg exited with code ${code}`)); }
      const buf = Buffer.concat(chunks, nbytes);
      const usable = buf.length - (buf.length % 4);   // whole float32 samples
      if (usable === 0) { return reject(new Error('ffmpeg produced no audio data')); }
      // Copy into a fresh, 4-byte-aligned ArrayBuffer. A pooled Buffer's
      // byteOffset isn't guaranteed aligned, which a direct Float32Array view
      // would reject. All supported platforms are little-endian, matching
      // f32le, so no per-sample byte swap is needed.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable);
      resolve(new Float32Array(ab));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); }
      err.transient = true;   // exec failure says nothing about the content
      reject(err);
    });
  });
}

// ── Analyse ──────────────────────────────────────────────────────────────────

/**
 * Estimate BPM + musical key for a decoded signal.
 *
 * @param {Float32Array} signal  mono PCM at ANALYSIS_SAMPLE_RATE
 * @param {object} essentia      a getEssentia() instance (caller awaits it first)
 * @returns {{
 *   bpm: number|null, bpmConfidence: number,
 *   key: string, scale: string, musicalKey: string|null, keyStrength: number
 * }}
 *
 * bpm is null when the estimate falls outside [MIN_BPM, MAX_BPM] (essentia
 * returned an implausible value). musicalKey is the "C major" / "A minor"
 * string for tracks.musical_key; the Auto-DJ side handles Camelot translation.
 * Caller inspects bpmConfidence / keyStrength to decide whether to trust /
 * persist the result.
 */
export function analyzeSignal(signal, essentia) {
  const vec = essentia.arrayToVector(signal);
  let rhythm = null;
  try {
    rhythm = essentia.RhythmExtractor2013(vec);
    const k = essentia.KeyExtractor(vec);
    const rawBpm = Math.round(rhythm.bpm);
    const bpm = (rawBpm >= MIN_BPM && rawBpm <= MAX_BPM) ? rawBpm : null;
    const key = k.key || '';
    const scale = k.scale || '';
    return {
      bpm,
      bpmConfidence: rhythm.confidence,
      key,
      scale,
      musicalKey: key ? `${key} ${scale}`.trim() : null,
      keyStrength: k.strength,
    };
  } finally {
    // Free WASM-heap allocations or the emscripten heap grows per analysed
    // track. arrayToVector() returns one vector; RhythmExtractor2013 also
    // returns vectors (ticks/estimates/bpmIntervals) alongside its scalars.
    // KeyExtractor returns only JS primitives, so nothing to free there.
    const free = (v) => { if (v && typeof v.delete === 'function') { v.delete(); } };
    free(vec);
    if (rhythm) { free(rhythm.ticks); free(rhythm.estimates); free(rhythm.bpmIntervals); }
  }
}

/**
 * Convenience: decode + analyse one file end to end.
 */
export async function analyzeFile(audioPath, ffmpegBin, opts = {}) {
  const signal = await decodePcmF32(audioPath, ffmpegBin, opts);
  return analyzeSignal(signal, await getEssentia());
}
