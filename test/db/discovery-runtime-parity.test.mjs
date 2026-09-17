// Real-model check of the two ONNX Runtime builds behind the discovery
// embedder: the WebAssembly build must produce the same vectors and genre
// tags as the native addon (vectors from either mix in one index, locally
// and across discovery-network peers), and a forced runtime must be the one
// that answers.
//
// GATED: needs the Discogs-EffNet weights (18 MB), which the unit suite must
// never download. Point MSTREAM_TEST_MODEL_CACHE at a directory that holds
// discogs-effnet-bsdynamic-1.onnx + .json — any server's
// storage.modelCacheDirectory after one discovery pass — and the test runs;
// otherwise it skips. Where the native addon has no binary (Intel Mac,
// 32-bit ARM) the wasm half still runs and the comparison is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEmbedder, EMBEDDING_MODELS } from '../../src/db/discovery-features-lib.js';

const cache = process.env.MSTREAM_TEST_MODEL_CACHE;
const spec = EMBEDDING_MODELS['effnet-discogs'];
const haveModel = !!cache
  && fs.existsSync(path.join(cache, spec.weights.filename))
  && fs.existsSync(path.join(cache, spec.labels.filename));
const skip = haveModel ? false : 'set MSTREAM_TEST_MODEL_CACHE to a directory holding the EffNet weights';

// 35 s of deterministic, music-shaped audio at the model's rate: a slow
// chord of three partials with a beat-like amplitude pulse and a little
// noise, so the 3 × 10 s analysis windows all land inside it.
function synthSignal() {
  const sr = spec.sampleRate;
  const n = 35 * sr;
  const out = new Float32Array(n);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const pulse = 0.6 + 0.4 * Math.max(0, Math.sin(2 * Math.PI * 2 * t));
    out[i] = pulse * (0.4 * Math.sin(2 * Math.PI * 110 * t)
      + 0.3 * Math.sin(2 * Math.PI * 220 * t)
      + 0.2 * Math.sin(2 * Math.PI * 330 * t))
      + 0.05 * rnd();
  }
  return out;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

test('EffNet on the WebAssembly runtime embeds a track and matches the native runtime', { skip }, async () => {
  const signal = synthSignal();

  const wasm = await createEmbedder('effnet-discogs', { modelCacheDir: cache, runtime: 'wasm', threads: 1 });
  assert.equal(wasm.runtime, 'wasm');
  assert.equal(wasm.threads, 1);
  const w = await wasm.analyzeSignal(signal);
  assert.equal(w.embedding.length, spec.dim);
  assert.ok(Math.abs(cosine(w.embedding, w.embedding) - 1) < 1e-6, 'L2-normalised vector');
  assert.ok(w.genreTags === null || (Array.isArray(w.genreTags) && w.genreTags.length <= spec.tagTopK));

  let native;
  try {
    native = await createEmbedder('effnet-discogs', { modelCacheDir: cache, runtime: 'native', threads: 1 });
  } catch (err) {
    // No native binary for this platform: the wasm half above is the test.
    if (err.dependencyMissing === true) { return; }
    throw err;
  }
  assert.equal(native.runtime, 'native');
  const n = await native.analyzeSignal(signal);
  const cos = cosine(n.embedding, w.embedding);
  assert.ok(cos > 0.9999, `native and wasm embeddings must agree (cosine ${cos})`);
  assert.deepEqual(w.genreTags, n.genreTags, 'genre tags must not depend on the runtime');
});

test('auto picks a runtime and reports it', { skip }, async () => {
  const embedder = await createEmbedder('effnet-discogs', { modelCacheDir: cache, runtime: 'auto', threads: 1 });
  assert.ok(['native', 'wasm'].includes(embedder.runtime), embedder.runtime);
  assert.ok(Array.isArray(embedder.skippedRuntimes));
  if (embedder.runtime === 'wasm') {
    assert.equal(embedder.skippedRuntimes[0]?.runtime, 'native', 'wasm in auto mode means native was tried first');
  }
});
