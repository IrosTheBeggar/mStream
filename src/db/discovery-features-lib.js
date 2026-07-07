// Embedding engine for the music-discovery dataset (discovery.db).
//
// This module owns the MODEL REGISTRY and the per-track embedding pipeline:
// decode (ffmpeg → mono f32 at the model's sample rate) → fixed-length
// windows → model inference → mean-pool → L2-normalize → one Float32Array
// per track. The discovery worker (discovery-backfill.mjs) is the only
// production caller.
//
// MODELS ARE DELIBERATELY SWAPPABLE. Vectors from different models (or
// model versions) live in incompatible spaces, so every stored row and every
// export snapshot carries a (model_id, model_version) pin, and the worker
// re-embeds rows whose pin doesn't match the active model. Adding an engine
// = one registry entry + (if it's a new kind) one embedder factory below.
// The project may yet trade the current Apache-licensed CLAP for a
// non-commercial-licensed model with better music quality (MTG Discogs-
// EffNet / MERT) if the commercial angle is dropped — this registry is what
// makes that a config change instead of a rewrite.
//
// The default engine is MTG's Discogs-EffNet — the strongest music-specific
// embedding model available, adopted after the project dropped all
// commercial aspects of the discovery feature (its weights are
// CC BY-NC-SA 4.0: non-commercial, share-alike — the license rides along in
// discovery_meta and every export manifest). Its weights are mirrored as a
// GitHub release asset under project control and downloaded on first use
// with sha256 verification — the lesson from Xenova/larger_clap_music
// silently vanishing off HF. Bonus: the same inference emits 400 Discogs
// style activations, which become free genre tags per track.
//
// LAION-CLAP (music_and_speech, Apache-2.0) stays selectable for operators
// who want a permissively-licensed dataset or (future) text→audio queries.
//
// All heavy runtimes are OPTIONAL dependencies imported lazily per model
// kind — a failed native install must never break the music server; the
// worker surfaces a clean error instead.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { decodePcmF32 } from './audio-analysis-lib.js';

// ── Registry ─────────────────────────────────────────────────────────────────
//
// key            stable mStream-side id — this is what lands in
//                discovery_tracks.model_id and the export manifest. Never
//                reuse a key for semantically different weights; bump
//                `version` (or add a new key) instead.
// kind           which embedder factory below handles it.
// version        OUR pin, stored per row; bump when the underlying weights
//                change meaningfully.
// dim            embedding length (floats).
// sampleRate     decode rate the model expects.
// segmentSeconds / segmentPositions
//                fixed windows fed to the model; their mean is the track
//                vector (validated in the spike: 3×10 s ≈ full-track quality
//                at a fraction of the cost).
const MODELS_RELEASE_BASE =
  'https://github.com/IrosTheBeggar/mStream/releases/download/discovery-models-1';

export const EMBEDDING_MODELS = {
  // MTG-UPF's Discogs-EffNet (trained on 4M Discogs releases / 400 styles).
  // DEFAULT. Weights are the project-mirrored copy of the official ONNX
  // export from essentia.upf.edu — small (18 MB), sha256-pinned, fetched on
  // first use into storage.modelCacheDirectory. The 'labels' file carries
  // the 400 style names so the activations head can fill genre_tags.
  'effnet-discogs': {
    kind: 'effnet-discogs',
    version: '1',
    dim: 1280,
    sampleRate: 16000,
    segmentSeconds: 10,
    segmentPositions: [0.25, 0.5, 0.75],
    // NON-COMMERCIAL license, accepted deliberately: the discovery feature
    // is free and must never be gated by / bundled into a paid offering.
    // ShareAlike: exported datasets built from these embeddings inherit
    // NC-SA terms (declared in the export manifest).
    license: 'CC-BY-NC-SA-4.0',
    attribution: 'Discogs-EffNet by Music Technology Group, Universitat Pompeu Fabra (essentia.upf.edu/models)',
    weights: {
      filename: 'discogs-effnet-bsdynamic-1.onnx',
      url: `${MODELS_RELEASE_BASE}/discogs-effnet-bsdynamic-1.onnx`,
      sha256: 'a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c',
    },
    labels: {
      filename: 'discogs-effnet-bsdynamic-1.json',
      url: `${MODELS_RELEASE_BASE}/discogs-effnet-bsdynamic-1.json`,
      sha256: 'a2e85b2e7372d5f8e0f35bdd6aeae1139f101087d183d0b2fb60b0ea0f01a0ff',
    },
    // essentia's TensorflowInputMusiCNN front-end contract (the model was
    // trained on exactly this mel pipeline — do not change independently).
    frameSize: 512,
    hopSize: 256,
    melBands: 96,
    patchFrames: 128,
    // Style activations >= this probability become genre_tags (top-K).
    tagThreshold: 0.1,
    tagTopK: 5,
  },
  'clap-music-and-speech': {
    kind: 'transformers-clap',
    hfRepo: 'Xenova/larger_clap_music_and_speech',   // base weights: laion/larger_clap_music_and_speech (Apache-2.0, verified 2026-07-01)
    version: '1',
    dim: 512,
    sampleRate: 48000,
    segmentSeconds: 10,
    segmentPositions: [0.25, 0.5, 0.75],
    dtype: 'fp32',
    license: 'Apache-2.0',
    attribution: 'LAION-CLAP (larger_clap_music_and_speech), ONNX conversion by Xenova',
  },
  // Deterministic, dependency-free pseudo-embedder. Exists for two reasons:
  // it lets the whole worker/task-queue/export pipeline be tested without a
  // model download, and it exercises the model-swap path for real (tests
  // flip between this and other pins). Not meaningful for similarity.
  'test-fake': {
    kind: 'fake',
    version: '1',
    dim: 8,
    sampleRate: 8000,
    segmentSeconds: 5,
    segmentPositions: [0.5],
    license: 'GPL-3.0',   // it's just mStream code
    attribution: 'mStream test fixture',
  },
};

export const DEFAULT_EMBEDDING_MODEL = 'effnet-discogs';

export function getModelSpec(key) {
  const spec = EMBEDDING_MODELS[key];
  if (!spec) {
    throw new Error(`unknown discovery embedding model '${key}' (known: ${Object.keys(EMBEDDING_MODELS).join(', ')})`);
  }
  return spec;
}

// ── Vector helpers ───────────────────────────────────────────────────────────

function l2normalize(v) {
  let ss = 0;
  for (let i = 0; i < v.length; i++) { ss += v[i] * v[i]; }
  const n = Math.sqrt(ss) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) { out[i] = v[i] / n; }
  return out;
}

function meanPool(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) { out[i] += v[i]; }
  }
  for (let i = 0; i < out.length; i++) { out[i] /= vectors.length; }
  return out;
}

// Fixed windows at the spec's fractional positions; the whole (padded-by-
// the-model) signal when the track is shorter than one window.
function segments(signal, spec) {
  const win = spec.segmentSeconds * spec.sampleRate;
  if (signal.length <= win) { return [signal]; }
  const out = [];
  for (const p of spec.segmentPositions) {
    const start = Math.min(Math.floor(signal.length * p), signal.length - win);
    out.push(signal.subarray(start, start + win));
  }
  return out;
}

// ── Model-file acquisition ───────────────────────────────────────────────────

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Ensure a pinned model file exists in `modelCacheDir`, downloading it (once)
 * from the project-controlled mirror when absent. The sha256 pin is the
 * integrity AND identity check: a cached file with the wrong hash is treated
 * as corrupt and re-fetched; a downloaded file with the wrong hash is
 * deleted and the pass fails cleanly (better no data than wrong-model data).
 * Exported for tests.
 */
export async function ensureModelFile({ filename, url, sha256 }, modelCacheDir) {
  if (!modelCacheDir) { throw new Error('modelCacheDir is required to download model files'); }
  const dest = path.join(modelCacheDir, filename);

  if (fs.existsSync(dest)) {
    if (sha256OfFile(dest) === sha256) { return dest; }
    // Corrupt / partial from a previous crash — refetch below.
    fs.rmSync(dest, { force: true });
  }

  fs.mkdirSync(modelCacheDir, { recursive: true });
  const tmp = `${dest}.downloading`;
  fs.rmSync(tmp, { force: true });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`model download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

  const actual = sha256OfFile(tmp);
  if (actual !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`model download checksum mismatch for ${filename}: expected ${sha256}, got ${actual}`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

// ── Embedder factories ───────────────────────────────────────────────────────

// Every factory returns { analyzeSignal(Float32Array) → Promise<{
//   embedding: Float32Array (spec.dim, L2-normalized),
//   genreTags: string[] | null      // model-derived style tags, when the
// }> }                              // model has a classification head
//
// MTG's Discogs-EffNet through onnxruntime-node, fed by the pure-JS mel
// front-end in effnet-mel.js — a parity-exact reimplementation of essentia's
// TensorflowInputMusiCNN (the pipeline the model was trained on), ~20×
// faster than the WASM-per-frame original and with no AGPL dependency in
// this path. One inference yields both the 1280-d embedding and the
// 400-style activations (→ genre tags).
async function createEffnetEmbedder(spec, { modelCacheDir } = {}) {
  let ort;
  try {
    // NOTE for Bun `--compile`: onnxruntime-node's loader requires a
    // per-(platform,arch) .node binary that upstream doesn't ship for every
    // target, so bundling it breaks cross-builds. It is marked `--external`
    // in scripts/build-bun.mjs — concatenation tricks don't help because
    // Bun's bundler constant-folds them. In a standalone binary this import
    // fails at runtime and lands in the catch below.
    ort = (await import('onnxruntime-node')).default;
  } catch (err) {
    // Distinguish "the package isn't there" from "it's there but this OS
    // can't load it" — the latter is the Alpine/musl case (onnxruntime
    // ships glibc-only binaries; gcompat doesn't cover its fortified
    // symbols), where the only fix is a glibc-based image.
    const muslHint = /ld-linux|Error relocating|ERR_DLOPEN/i.test(`${err.message} ${err.code || ''}`)
      ? ' — this system cannot load onnxruntime’s glibc binaries (musl/Alpine containers are not supported; use a glibc-based image such as Debian/Ubuntu)'
      : '';
    const e = new Error(`onnxruntime-node is not available — the '${spec.weights.filename}' embedding model cannot run${muslHint} (${err.message})`);
    e.dependencyMissing = true;
    throw e;
  }
  const { createMelExtractor } = await import('./effnet-mel.js');
  const { melFrames } = createMelExtractor();

  const modelPath = await ensureModelFile(spec.weights, modelCacheDir);
  const labelsPath = await ensureModelFile(spec.labels, modelCacheDir);
  const classes = JSON.parse(fs.readFileSync(labelsPath, 'utf8')).classes;

  const session = await ort.InferenceSession.create(modelPath);

  return {
    // Core path: pre-cut segments (either sliced from one decoded signal by
    // analyzeSignal below, or seek-decoded windows from analyzeFile).
    async analyzeSegments(segs) {
      // Mel rows per segment → non-overlapping 128-frame patches. A segment
      // shorter than one patch is zero-padded (silence rows) so short-but-
      // eligible tracks still embed instead of crashing.
      const patches = [];
      for (const seg of segs) {
        const rows = melFrames(seg);
        if (!rows.length) { continue; }
        while (rows.length < spec.patchFrames) { rows.push(new Float32Array(spec.melBands)); }
        for (let start = 0; start + spec.patchFrames <= rows.length; start += spec.patchFrames) {
          const patch = new Float32Array(spec.patchFrames * spec.melBands);
          for (let f = 0; f < spec.patchFrames; f++) { patch.set(rows[start + f], f * spec.melBands); }
          patches.push(patch);
        }
      }
      if (!patches.length) { throw new Error('no audio content to analyse'); }

      const batch = new Float32Array(patches.length * spec.patchFrames * spec.melBands);
      patches.forEach((p, i) => batch.set(p, i * spec.patchFrames * spec.melBands));
      const out = await session.run({
        melspectrogram: new ort.Tensor('float32', batch, [patches.length, spec.patchFrames, spec.melBands]),
      });

      const embDim = out.embeddings.dims[1];
      const perPatchEmb = [];
      for (let i = 0; i < out.embeddings.dims[0]; i++) {
        perPatchEmb.push(Float32Array.from(out.embeddings.data.subarray(i * embDim, (i + 1) * embDim)));
      }

      const actDim = out.activations.dims[1];
      const perPatchAct = [];
      for (let i = 0; i < out.activations.dims[0]; i++) {
        perPatchAct.push(Float32Array.from(out.activations.data.subarray(i * actDim, (i + 1) * actDim)));
      }
      const styles = meanPool(perPatchAct);
      const genreTags = Array.from(styles)
        .map((p, i) => ({ p, name: classes[i] }))
        .filter((s) => s.p >= spec.tagThreshold)
        .sort((a, b) => b.p - a.p)
        .slice(0, spec.tagTopK)
        .map((s) => s.name);

      return {
        embedding: l2normalize(meanPool(perPatchEmb)),
        genreTags: genreTags.length ? genreTags : null,
      };
    },
    // Whole-signal path (callers without a known duration): cut the fixed
    // windows out of the decoded signal, then run the core path. Returns
    // analyzeSegments' promise directly — no `async` needed.
    analyzeSignal(signal) {
      return this.analyzeSegments(segments(signal, spec));
    },
  };
}

// LAION-CLAP through transformers.js. The processor computes the model's mel
// patches from a raw Float32Array directly — no essentia, no wav wrapping.
// Model files download to `modelCacheDir` on first use (set it — the default
// cache would land inside node_modules); loading takes ~20 s, so the worker
// creates ONE embedder per run.
async function createClapEmbedder(spec, { modelCacheDir } = {}) {
  let transformers;
  try {
    // NOTE for Bun `--compile`: this package (via its onnxruntime-node
    // dependency) requires per-platform .node binaries that upstream doesn't
    // ship for every target, so bundling it breaks cross-builds. It is marked
    // `--external` in scripts/build-bun.mjs — concatenation tricks don't help
    // here because Bun's bundler constant-folds them. In a standalone binary
    // this import fails at runtime and lands in the catch below.
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    // Optional dependency absent (install failed / pruned / not bundled).
    // The worker turns this into a clean fatal event; the music server
    // itself is unaffected.
    const e = new Error(`@huggingface/transformers is not installed — the '${spec.hfRepo}' embedding model cannot run (${err.message})`);
    e.dependencyMissing = true;
    throw e;
  }
  const { AutoProcessor, ClapAudioModelWithProjection, env } = transformers;
  if (modelCacheDir) { env.cacheDir = modelCacheDir; }

  const processor = await AutoProcessor.from_pretrained(spec.hfRepo);
  const model = await ClapAudioModelWithProjection.from_pretrained(spec.hfRepo, { dtype: spec.dtype });

  return {
    async analyzeSignal(signal) {
      const segEmbeds = [];
      for (const seg of segments(signal, spec)) {
        const inputs = await processor(seg);
        const { audio_embeds: audioEmbeds } = await model(inputs);
        segEmbeds.push(Float32Array.from(audioEmbeds.data));
      }
      return { embedding: l2normalize(meanPool(segEmbeds)), genreTags: null };
    },
  };
}

// Deterministic pseudo-embedder: dim buckets of per-band RMS over the
// segment. Same audio → same vector, on every platform, no dependencies.
function createFakeEmbedder(spec) {
  return {
    // Not declared async (nothing to await) — callers `await` it anyway,
    // which is a no-op on a plain value, so the interface stays uniform
    // with the real embedders.
    analyzeSignal(signal) {
      const segEmbeds = segments(signal, spec).map((seg) => {
        const v = new Float32Array(spec.dim);
        const band = Math.max(1, Math.floor(seg.length / spec.dim));
        for (let b = 0; b < spec.dim; b++) {
          let ss = 0;
          const start = b * band;
          const end = Math.min(start + band, seg.length);
          for (let i = start; i < end; i++) { ss += seg[i] * seg[i]; }
          v[b] = Math.sqrt(ss / Math.max(1, end - start));
        }
        return v;
      });
      return { embedding: l2normalize(meanPool(segEmbeds)), genreTags: null };
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the embedder for a registry key. Expensive for real models (module
 * load + weights download on first use + graph init) — call once per run.
 */
export async function createEmbedder(key, opts = {}) {
  const spec = getModelSpec(key);
  switch (spec.kind) {
    case 'effnet-discogs': return { spec, ...(await createEffnetEmbedder(spec, opts)) };
    case 'transformers-clap': return { spec, ...(await createClapEmbedder(spec, opts)) };
    case 'fake': return { spec, ...createFakeEmbedder(spec) };
    default: throw new Error(`no embedder factory for model kind '${spec.kind}'`);
  }
}

/**
 * Decode + analyse one file: ffmpeg → mono f32 at the model's rate →
 * analyze. Decode reuses audio-analysis-lib's ffmpeg glue.
 *
 * When the caller knows the track duration (the worker reads it from the
 * library DB) and the embedder supports pre-cut segments, only the analysis
 * WINDOWS are decoded (ffmpeg input-seek per window) instead of the whole
 * file — for a typical 4-minute track that's 30 s of decode instead of
 * 240 s. Without a duration (or for whole-signal embedders) it falls back
 * to the original full decode, which is also the path for tracks short
 * enough to fit inside one window.
 *
 * @returns {Promise<{embedding: Float32Array, genreTags: string[]|null}>}
 */
export async function analyzeFile(embedder, audioPath, ffmpegBin, { maxSeconds = 600, timeoutMs, durationSec } = {}) {
  const spec = embedder.spec;
  const decodeOpts = {
    sampleRate: spec.sampleRate,
    ...(timeoutMs ? { timeoutMs } : {}),
  };

  const seekable = typeof embedder.analyzeSegments === 'function'
    && Number.isFinite(durationSec)
    && Array.isArray(spec.segmentPositions)
    && durationSec > spec.segmentSeconds * 2;   // short tracks: one decode is cheaper

  if (seekable) {
    const cappedDuration = Math.min(durationSec, maxSeconds);
    const segs = [];
    for (const p of spec.segmentPositions) {
      const start = Math.max(0, Math.min(cappedDuration * p, cappedDuration - spec.segmentSeconds));
      segs.push(await decodePcmF32(audioPath, ffmpegBin, {
        ...decodeOpts,
        seekSec: start,
        maxSeconds: spec.segmentSeconds,
      }));
    }
    return embedder.analyzeSegments(segs);
  }

  const signal = await decodePcmF32(audioPath, ffmpegBin, { ...decodeOpts, maxSeconds });
  return embedder.analyzeSignal(signal);
}
