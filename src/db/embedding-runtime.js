// Runtime selection for the discovery-embedding model (Discogs-EffNet, an
// ONNX graph — see the registry in discovery-features-lib.js).
//
// Two builds of the same ONNX Runtime can run it, through the same session /
// tensor API, and their outputs agree to ~1e-6 (measured 2026-09-16: cosine
// 1.0 to nine digits, identical genre tags), so vectors from either mix
// freely — locally and across discovery-network peers:
//
//   native  onnxruntime-node — an N-API addon + the ONNX Runtime shared
//           library. Fastest (~5 ms per 128-frame patch on a desktop core).
//           An OPTIONAL npm dependency: upstream ships binaries for Linux
//           x64/arm64 (glibc), Windows x64/arm64 and Apple Silicon only, so
//           it is absent on Intel Macs and 32-bit ARM; on musl it does not
//           load even through gcompat (Alpine 3.24 + gcompat 1.1.0 + ORT
//           1.29: "Error relocating libonnxruntime.so.1: fcntl64: symbol not
//           found" — the Docker image's shape, measured 2026-09-17); and it
//           can never ship inside the Bun standalone binary (the addon can't
//           be embedded, and since Bun 1.3.4 a compiled binary doesn't
//           resolve external packages either — issue #999 was exactly that:
//           no bundle, on any platform, could ever load it).
//   wasm    onnxruntime-web's WebAssembly build — no native code, so it runs
//           wherever the JavaScript engine does: every bundle (musl and
//           Intel Mac included), Node on any CPU, Alpine without gcompat.
//           3-8× slower per patch than native (16-42 ms single-threaded,
//           machine-dependent; threads help batches) and ~50-250 MB more
//           resident memory in the worker, which is why native stays first
//           where it loads.
//
// 'auto' (the default) tries native and falls back to wasm; standalone
// bundles go straight to wasm — nothing native is ever shipped there.
// 'native' and 'wasm' force one and fail loudly instead of falling back:
// the support answer to "why is my box slow / why isn't this working".
//
// Nothing here imports a runtime at module load: the worker only needs one
// when there is work, and a failed optional install must never break the
// server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRoot, isBunStandalone } from '../util/esm-helpers.js';

export const EMBEDDING_RUNTIMES = ['auto', 'native', 'wasm'];

// The two files the wasm build needs on disk. Bundles ship them in
// bin/onnxruntime-web next to the server (scripts/build-bun.mjs); everywhere
// else the npm package finds them relative to itself and no override is set.
export const WASM_RUNTIME_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

// Threads. Native ONNX Runtime defaults to every core — what makes a Pi
// unresponsive for the hours a backfill takes — and the wasm build defaults
// to one. Both get the same cap: two threads, one on small-memory machines
// (the wasm worker measured ~250 MB resident under Bun before the second
// thread, and the 1 GB demo droplet must not swap). An explicit setting
// wins. Exported for tests.
const SMALL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export function threadPolicy({
  cpus = os.availableParallelism?.() ?? os.cpus().length,
  totalMemBytes = os.totalmem(),
  override,
} = {}) {
  if (Number.isInteger(override) && override >= 1) { return override; }
  if (totalMemBytes <= SMALL_MEMORY_BYTES) { return 1; }
  return Math.max(1, Math.min(2, cpus));
}

// Ordered candidates for a setting. Exported for tests.
export function planRuntimes(setting = 'auto', { standalone = isBunStandalone } = {}) {
  if (setting === 'native' || setting === 'wasm') { return [setting]; }
  if (setting !== 'auto') {
    throw new Error(`unknown embedding runtime '${setting}' (expected one of ${EMBEDDING_RUNTIMES.join(', ')})`);
  }
  return standalone ? ['wasm'] : ['native', 'wasm'];
}

// Where the wasm build reads its files from — null means "the package's own
// dist directory". MUST be a real directory on disk, with a trailing
// separator: onnxruntime-web spawns worker threads that import the .mjs glue
// from this path, and a path inside Bun's virtual filesystem hangs them
// (measured; the files are therefore staged next to the binary, never
// embedded in it). Exported for tests.
export function wasmRuntimeDir({ standalone = isBunStandalone, root = appRoot } = {}) {
  return standalone ? path.join(root, 'bin', 'onnxruntime-web') + path.sep : null;
}

// Turn a runtime's load error into the one line the log needs. The native
// addon fails in two very different ways: not installed at all (no binary
// for this platform, or the optional dependency skipped) versus present but
// unloadable (a glibc build on musl without gcompat, Bun's musl build
// refusing glibc addons outright, an unsupported CPU).
function describeLoadFailure(runtime, err) {
  const text = `${err?.message || err} ${err?.code || ''}`;
  if (runtime === 'native') {
    if (/ld-linux|Error relocating|ERR_DLOPEN|linked against glibc|DT_NEEDED/i.test(text)) {
      return `this system cannot load its native binaries (${err.message})`;
    }
    if (/MODULE_NOT_FOUND|Cannot find (package|module)/i.test(text)) {
      return 'onnxruntime-node is not installed or has no binary for this platform';
    }
  }
  return err?.message || String(err);
}

const defaultImporters = {
  native: () => import('onnxruntime-node'),
  wasm: () => import('onnxruntime-web'),
};

// Both packages export the API object either as the module or as `default`
// (CommonJS interop for onnxruntime-node, ESM for onnxruntime-web).
function apiOf(mod) {
  return mod?.default?.InferenceSession ? mod.default : mod;
}

/**
 * Load the first runtime in the plan that works, optionally proving it with
 * a session. `createSession(ort, sessionOptions)` is called for each loaded
 * candidate; a failure there moves on to the next candidate too, so a native
 * install that imports but can't build a session still ends on wasm.
 *
 * Resolves { ort, runtime, threads, sessionOptions, session, skipped } where
 * `skipped` lists the candidates that failed and why (the worker reports
 * them so the log says which runtime is in use and why).
 *
 * Rejects with dependencyMissing = true when no candidate works — the
 * worker's exit-4 contract (task-queue.js latches the pass off until
 * restart, because the failure is structural and repeats identically).
 */
export async function loadEmbeddingRuntime({
  setting = 'auto',
  threads,
  createSession,
  importers = defaultImporters,
  standalone = isBunStandalone,
  wasmDir = wasmRuntimeDir({ standalone }),
} = {}) {
  const plan = planRuntimes(setting, { standalone });
  const nThreads = threadPolicy({ override: threads });
  const skipped = [];

  for (const runtime of plan) {
    try {
      let ort;
      let sessionOptions;
      if (runtime === 'native') {
        ort = apiOf(await importers.native());
        sessionOptions = { intraOpNumThreads: nThreads };
      } else {
        if (wasmDir) {
          const missing = WASM_RUNTIME_FILES.filter((f) => !fs.existsSync(path.join(wasmDir, f)));
          if (missing.length) {
            throw new Error(`runtime files missing from ${wasmDir}: ${missing.join(', ')} (the bundle is incomplete)`);
          }
        }
        ort = apiOf(await importers.wasm());
        if (wasmDir) { ort.env.wasm.wasmPaths = wasmDir; }
        ort.env.wasm.numThreads = nThreads;
        sessionOptions = { executionProviders: ['wasm'] };
      }
      const session = createSession ? await createSession(ort, sessionOptions) : null;
      return { ort, runtime, threads: nThreads, sessionOptions, session, skipped };
    } catch (err) {
      skipped.push({ runtime, reason: describeLoadFailure(runtime, err) });
    }
  }

  const e = new Error(
    'no embedding runtime could be loaded — '
    + skipped.map((s) => `${s.runtime}: ${s.reason}`).join('; '));
  e.dependencyMissing = true;
  e.skipped = skipped;
  throw e;
}
