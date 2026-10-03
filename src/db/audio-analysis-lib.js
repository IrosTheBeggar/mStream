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
 * @param {object} [opts]
 * @param {string} [opts.bpmMethod='multifeature']  RhythmExtractor2013 method:
 *   'multifeature' (committee estimator — most accurate, emits the ~0–5.32
 *   confidence) or 'degara' (~6× faster, same beat-tracker family, but its
 *   confidence output is always 0 by documented essentia behaviour — callers
 *   must not confidence-gate degara results).
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
export function analyzeSignal(signal, essentia, opts = {}) {
  const bpmMethod = opts.bpmMethod || 'multifeature';
  const vec = essentia.arrayToVector(signal);
  let rhythm = null;
  try {
    // Explicit maxTempo/minTempo (208/40) are the algorithm defaults — spelled
    // out because the method parameter sits between them positionally.
    rhythm = essentia.RhythmExtractor2013(vec, 208, bpmMethod, 40);
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
 * Convenience: decode + analyse one file end to end. Decode options and
 * opts.bpmMethod both ride in the same opts bag.
 */
export async function analyzeFile(audioPath, ffmpegBin, opts = {}) {
  const signal = await decodePcmF32(audioPath, ffmpegBin, opts);
  return analyzeSignal(signal, await getEssentia(), { bpmMethod: opts.bpmMethod });
}

// ── Worker SQL ───────────────────────────────────────────────────────────────
//
// The analysis worker's statements, here rather than inline in
// audio-analysis-backfill.mjs so tests can run the exact text (the worker
// parses argv and exits at import; this module loads essentia lazily).
//
// audio_analysis_lookups (V54, values since V78) is keyed on the canonical
// hash COALESCE(audio_hash, file_hash) and holds what essentia MEASURED for
// that audio — never a tag value. A re-parse writes the file's tags over the
// track row (the scanner UPSERT keeps a pure-essentia row's values, but a
// mixed tag+essentia row and a moved file's new row come back NULL), so each
// pass first copies the measured values back from the ledger: no decode, no
// cooldown. INVARIANT: an 'analyzed' commit always carries at least one
// value (the worker only commits when bpm or key is usable), so an
// 'analyzed' row with both values NULL is a pre-V78 row that recorded none.

// Fill NULLs only — never clobber a tag-sourced bpm/key — across every copy
// sharing the canonical hash. bpm_source becomes 'essentia' only when it was
// NULL (a tag-sourced row keeps its 'tag' provenance even if we add the key).
// Params: bpm, musical_key, canonical hash.
export const FILL_ANALYSIS_SQL = `
  UPDATE tracks
     SET bpm         = COALESCE(bpm, ?),
         musical_key = COALESCE(musical_key, ?),
         bpm_source  = CASE WHEN bpm_source IS NULL THEN 'essentia' ELSE bpm_source END
   WHERE COALESCE(audio_hash, file_hash) = ?
     AND (bpm IS NULL OR musical_key IS NULL)
`;

// An 'analyzed' result and the values essentia measured — the usable ones,
// including a bpm measured for a row whose bpm is a tag's, so removing that
// tag later falls back to the measurement. A value this attempt could not
// resolve keeps the one an earlier attempt recorded.
// Params: canonical hash, attempt time (s), bpm, musical_key.
export const RECORD_ANALYZED_SQL = `
  INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome, attempts, bpm, musical_key)
  VALUES (?, ?, 'analyzed', 1, ?, ?)
  ON CONFLICT(audio_hash) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = audio_analysis_lookups.attempts + 1,
    bpm             = COALESCE(excluded.bpm, audio_analysis_lookups.bpm),
    musical_key     = COALESCE(excluded.musical_key, audio_analysis_lookups.musical_key)
`;

// A 'lowconf' / 'error' attempt. Leaves the recorded values alone: a retry
// that measured nothing usable says nothing against an earlier measurement.
// Params: canonical hash, attempt time (s), outcome.
export const RECORD_ATTEMPT_SQL = `
  INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome, attempts)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(audio_hash) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = audio_analysis_lookups.attempts + 1
`;

// Copy measured values back onto tracks whose bpm/key is NULL, from the
// ledger row of the same audio (any outcome — a lowconf retry keeps the
// values of an earlier 'analyzed' attempt). Fill-NULL only, so a tag value
// always stands; provenance as in FILL_ANALYSIS_SQL. No duration / genre
// filter: this restores what was already measured, it starts nothing new.
// No params.
export const REFILL_FROM_LEDGER_SQL = `
  UPDATE tracks
     SET bpm = COALESCE(bpm, (SELECT la.bpm FROM audio_analysis_lookups la
                               WHERE la.audio_hash = COALESCE(tracks.audio_hash, tracks.file_hash))),
         musical_key = COALESCE(musical_key, (SELECT la.musical_key FROM audio_analysis_lookups la
                               WHERE la.audio_hash = COALESCE(tracks.audio_hash, tracks.file_hash))),
         bpm_source = CASE WHEN bpm_source IS NULL THEN 'essentia' ELSE bpm_source END
   WHERE (bpm IS NULL OR musical_key IS NULL)
     AND EXISTS (SELECT 1 FROM audio_analysis_lookups la
                  WHERE la.audio_hash = COALESCE(tracks.audio_hash, tracks.file_hash)
                    AND ((tracks.bpm IS NULL AND la.bpm IS NOT NULL)
                      OR (tracks.musical_key IS NULL AND la.musical_key IS NOT NULL)))
`;

// Tracks needing analysis: NULL bpm OR NULL key, in the duration window, not
// an excluded genre, off cooldown. One representative row per canonical hash
// (MIN(id) — SQLite takes the other bare columns from that same row), so
// duplicate files are decoded once. 'error' rows come off cooldown sooner.
// An 'analyzed' row with no recorded values (pre-V78) is not done: it never
// stored what it measured, so its cooldown would otherwise hide a track whose
// values a re-parse cleared.
// Params: minDurationSec, maxDurationSec, ...genres (lower-cased, genreCount
// of them), errorCutoff, longCutoff, limit.
export function selectEligibleSql(genreCount) {
  const genreClause = genreCount > 0
    ? `AND NOT EXISTS (
         SELECT 1 FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
          WHERE tg.track_id = t.id AND LOWER(g.name) IN (${new Array(genreCount).fill('?').join(',')})
       )`
    : '';
  return `
    SELECT MIN(t.id) AS track_id,
           COALESCE(t.audio_hash, t.file_hash) AS canon_hash,
           t.filepath AS filepath,
           t.duration AS duration,
           lib.root_path AS root
      FROM tracks t
      JOIN libraries lib ON lib.id = t.library_id
      LEFT JOIN audio_analysis_lookups la
             ON la.audio_hash = COALESCE(t.audio_hash, t.file_hash)
     WHERE (t.bpm IS NULL OR t.musical_key IS NULL)
       AND t.duration IS NOT NULL
       AND t.duration >= ? AND t.duration <= ?
       AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
       ${genreClause}
       AND (
            la.audio_hash IS NULL
         OR (la.outcome = 'analyzed' AND la.bpm IS NULL AND la.musical_key IS NULL)
         OR la.last_attempt_at < (CASE WHEN la.outcome = 'error' THEN ? ELSE ? END)
       )
     GROUP BY COALESCE(t.audio_hash, t.file_hash)
     ORDER BY track_id
     LIMIT ?
  `;
}
