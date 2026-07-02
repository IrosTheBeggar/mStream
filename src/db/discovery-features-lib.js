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
// The default engine is LAION-CLAP (music_and_speech), Apache-2.0, via
// @huggingface/transformers (transformers.js) on its bundled onnxruntime-node
// backend — validated in the 2026-07-01 spike (Node 24, ~2.5-3.6 s/track
// inference, sane cosine structure on real music). transformers.js is an
// OPTIONAL dependency: a failed native install must never break the music
// server, so it is imported lazily and only when a CLAP-kind model is
// actually requested; the worker surfaces a clean error if it's missing.
//
// ⚠ Weights availability: Xenova/larger_clap_music vanished from HF between
// planning and the spike. Whatever model gets pinned into a shared network
// must eventually be mirrored under project control (the registry's hfRepo
// is a download source, not an identity — model_id/version is the identity).

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
export const EMBEDDING_MODELS = {
  'clap-music-and-speech': {
    kind: 'transformers-clap',
    hfRepo: 'Xenova/larger_clap_music_and_speech',   // base weights: laion/larger_clap_music_and_speech (Apache-2.0, verified 2026-07-01)
    version: '1',
    dim: 512,
    sampleRate: 48000,
    segmentSeconds: 10,
    segmentPositions: [0.25, 0.5, 0.75],
    dtype: 'fp32',
  },
  // Deterministic, dependency-free pseudo-embedder. Exists for two reasons:
  // it lets the whole worker/task-queue/export pipeline be tested without a
  // ~700 MB model download, and it exercises the model-swap path for real
  // (tests flip between this and other pins). Not meaningful for similarity.
  'test-fake': {
    kind: 'fake',
    version: '1',
    dim: 8,
    sampleRate: 8000,
    segmentSeconds: 5,
    segmentPositions: [0.5],
  },
};

export const DEFAULT_EMBEDDING_MODEL = 'clap-music-and-speech';

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

// ── Embedder factories ───────────────────────────────────────────────────────

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
    async embedSignal(signal) {
      const segEmbeds = [];
      for (const seg of segments(signal, spec)) {
        const inputs = await processor(seg);
        const { audio_embeds: audioEmbeds } = await model(inputs);
        segEmbeds.push(Float32Array.from(audioEmbeds.data));
      }
      return l2normalize(meanPool(segEmbeds));
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
    embedSignal(signal) {
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
      return l2normalize(meanPool(segEmbeds));
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
    case 'transformers-clap': return { spec, ...(await createClapEmbedder(spec, opts)) };
    case 'fake': return { spec, ...createFakeEmbedder(spec) };
    default: throw new Error(`no embedder factory for model kind '${spec.kind}'`);
  }
}

/**
 * Decode + embed one file. Decode reuses audio-analysis-lib's ffmpeg glue
 * (pure child_process code — the AGPL essentia part of that module is only
 * ever loaded via its own getEssentia(), which this path never calls),
 * resampled to the model's expected rate.
 *
 * @returns {Promise<Float32Array>} L2-normalized, spec.dim long
 */
export async function embedFile(embedder, audioPath, ffmpegBin, { maxSeconds = 600, timeoutMs } = {}) {
  const signal = await decodePcmF32(audioPath, ffmpegBin, {
    sampleRate: embedder.spec.sampleRate,
    maxSeconds,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return embedder.embedSignal(signal);
}
