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
//           found", measured 2026-09-17); and it can never ship inside the
//           Bun standalone binary (the addon can't be embedded, and since
//           Bun 1.3.4 a compiled binary doesn't resolve external packages
//           either — issue #999 was exactly that: no bundle, on any
//           platform, could ever load it). One failure shape is worse than
//           an error: the addon paired with an OLDER libonnxruntime than it
//           was built against — the linuxserver Docker image replaces the
//           bundled library with Alpine's package, which lags npm — prints
//           "The requested API version [29] is not available …" and then
//           SEGFAULTS inside the import, killing the whole worker before any
//           catch runs (seen on a production image 2026-09/10: every nightly
//           pass died that way, nothing was ever embedded). Auto mode
//           therefore probes the addon in a throwaway process first
//           (embedding-runtime-probe.mjs) and skips it when the probe dies.
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

import child from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot, getDirname, isBunStandalone } from '../util/esm-helpers.js';

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

// ── Out-of-process probe of the native addon ────────────────────────────────
//
// Importing onnxruntime-node can kill the process outright (see the header),
// and nothing in-process survives that to fall back. So auto mode first loads
// the addon — and builds a session on the real model, with the thread option
// the worker will use — in a throwaway child (embedding-runtime-probe.mjs)
// and reads its verdict: a child that exits without one died, and the addon
// is then skipped with the crash spelled out from its stderr. Ordinary load
// errors are left to the in-process import, which reproduces them with the
// usual diagnosis. The cost is one extra process per pass (well under a
// second on a desktop, a few seconds on a Pi, against a pass budget of
// minutes); standalone bundles never pay it — their plan is wasm-only.

const PROBE_SCRIPT = path.join(getDirname(import.meta.url), 'embedding-runtime-probe.mjs');

// Generous: an import plus one session build on an 18 MB model takes a few
// seconds on the slowest supported hardware. A load that takes longer than
// this would hang the worker just as surely as a crash kills it.
export const NATIVE_PROBE_TIMEOUT_MS = 60 * 1000;

// Sentinel lines the probe looks for in the crash's stderr tail.
const API_VERSION_SKEW = /requested API version .* is not available/i;

// The addon's entry file as a file:// URL, resolved here (CommonJS main) so
// the probe imports it by absolute path. Throws like the in-process import
// does when the package is not installed — the caller lets that case reach
// the regular "not installed" diagnosis.
export function nativeModuleUrl() {
  return pathToFileURL(createRequire(import.meta.url).resolve('onnxruntime-node')).href;
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch (_err) { /* not a verdict line */ }
  }
  return null;
}

function describeCrash(how, stderr) {
  const tail = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
  const hint = API_VERSION_SKEW.test(tail)
    ? ' — the addon is newer than the ONNX Runtime library it loaded at run time'
      + ' (a system libonnxruntime standing in for the bundled one?)'
    : '';
  return `the addon crashed while loading (${how})${tail ? `: ${tail}` : ''}${hint}`;
}

/**
 * Load the native addon in a child process and report whether doing so
 * in-process is safe. Resolves (never rejects) with:
 *   { safe: true,  ok: true }                  the probe loaded (and built a
 *                                              session when modelPath was given)
 *   { safe: true,  ok: false, error }          the addon threw an ordinary
 *                                              error — not a crash
 *   { safe: false, ok: false, reason }         the child died or hung: the
 *                                              addon must not be imported here
 * A probe that cannot even start counts as safe: it proves nothing, and the
 * in-process import then behaves exactly as it did before the probe existed.
 */
export function probeNativeRuntime({
  moduleUrl,
  modelPath = null,
  threads = 1,
  timeoutMs = NATIVE_PROBE_TIMEOUT_MS,
  script = PROBE_SCRIPT,
  fork = child.fork,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (verdict) => { if (!settled) { settled = true; resolve(verdict); } };
    let proc;
    try {
      // Same launch path as the workers (child.fork handles Electron and
      // Bun-interpreted alike); a clean execArgv so flags of THIS process
      // (a test runner's, an inspector's) don't reach the probe.
      proc = fork(script, [JSON.stringify({ moduleUrl, modelPath, threads })],
        { silent: true, execArgv: [] });
    } catch (err) {
      settle({ safe: true, ok: false, error: `the probe could not start: ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch (_err) { /* already gone */ }
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      settle({ safe: true, ok: false, error: `the probe could not start: ${err.message}` });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      const verdict = lastJsonLine(stdout);
      if (verdict?.ok === true) { settle({ safe: true, ok: true }); return; }
      if (verdict && verdict.ok === false) {
        settle({ safe: true, ok: false, error: String(verdict.error || 'unknown error') });
        return;
      }
      if (timedOut) {
        settle({
          safe: false, ok: false,
          reason: `the addon did not finish loading within ${Math.round(timeoutMs / 1000)} s (the probe was killed)`,
        });
        return;
      }
      // A clean exit with no verdict: the import never settled and nothing
      // else kept the child alive. In-process that is a worker that quietly
      // never embeds anything — unusable, just not a crash.
      if (!signal && code === 0) {
        settle({ safe: false, ok: false, reason: "the addon's load never completed (the probe exited without a verdict)" });
        return;
      }
      settle({ safe: false, ok: false, reason: describeCrash(signal || `exit code ${code}`, stderr) });
    });
  });
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
 * In auto mode the native addon is probed out of process before it is
 * imported here (probeNativeRuntime above); `probeModelPath` makes that
 * probe build a session on the real model too. `probe` is injectable
 * (false disables it), as is `resolveNative`.
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
  probeModelPath = null,
  probe = probeNativeRuntime,
  probeTimeoutMs = NATIVE_PROBE_TIMEOUT_MS,
  resolveNative = nativeModuleUrl,
} = {}) {
  const plan = planRuntimes(setting, { standalone });
  const nThreads = threadPolicy({ override: threads });
  const skipped = [];

  for (const runtime of plan) {
    // Only worth probing when there is somewhere to fall back to: a forced
    // 'native' is meant to fail loudly, and a crash is as loud as it gets.
    if (runtime === 'native' && plan.length > 1 && probe) {
      let moduleUrl = null;
      try { moduleUrl = resolveNative(); } catch (_err) { /* not installed: the import below says so */ }
      if (moduleUrl) {
        const verdict = await probe({
          moduleUrl, modelPath: probeModelPath, threads: nThreads, timeoutMs: probeTimeoutMs,
        });
        if (verdict && verdict.safe === false) {
          skipped.push({ runtime, reason: verdict.reason });
          continue;
        }
      }
    }
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
