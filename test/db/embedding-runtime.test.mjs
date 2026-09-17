// Runtime selection for the discovery-embedding model
// (src/db/embedding-runtime.js): which ONNX Runtime build is tried in which
// order, the thread cap, where a bundle finds the wasm files, and the
// fallback / failure contract — all with injected importers, so nothing here
// needs the native addon or the 18 MB model. The last test loads the real
// onnxruntime-web package (a regular dependency) to prove the API shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  planRuntimes, threadPolicy, wasmRuntimeDir, loadEmbeddingRuntime, EMBEDDING_RUNTIMES,
} from '../../src/db/embedding-runtime.js';

const GB = 1024 ** 3;

// A minimal stand-in for either package's API surface. The importers below
// are plain functions (loadEmbeddingRuntime awaits whatever they return, so
// a synchronous throw lands in the same catch as a rejected import()).
function fakeOrt(name, { createFails } = {}) {
  return {
    InferenceSession: {
      create: () => (createFails
        ? Promise.reject(new Error(`${name} cannot build a session`))
        : Promise.resolve({ name })),
    },
    env: { wasm: {} },
  };
}

test('planRuntimes: auto is native-then-wasm outside a bundle, wasm only inside one', () => {
  assert.deepEqual(EMBEDDING_RUNTIMES, ['auto', 'native', 'wasm']);
  assert.deepEqual(planRuntimes('auto', { standalone: false }), ['native', 'wasm']);
  assert.deepEqual(planRuntimes('auto', { standalone: true }), ['wasm']);
  assert.deepEqual(planRuntimes(undefined, { standalone: false }), ['native', 'wasm']);
  // A forced runtime is honoured even where it would not be chosen.
  assert.deepEqual(planRuntimes('native', { standalone: true }), ['native']);
  assert.deepEqual(planRuntimes('wasm', { standalone: false }), ['wasm']);
  assert.throws(() => planRuntimes('gpu', { standalone: false }), /unknown embedding runtime 'gpu'/);
});

test('threadPolicy: two threads, one on small-memory machines, an explicit setting wins', () => {
  assert.equal(threadPolicy({ cpus: 8, totalMemBytes: 16 * GB }), 2);
  assert.equal(threadPolicy({ cpus: 1, totalMemBytes: 16 * GB }), 1);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 2 * GB }), 1);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 1 * GB }), 1);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 16 * GB, override: 6 }), 6);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 1 * GB, override: 3 }), 3);
  // Nonsense overrides fall through to the policy.
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 16 * GB, override: 0 }), 2);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 16 * GB, override: 1.5 }), 2);
  assert.equal(threadPolicy({ cpus: 4, totalMemBytes: 16 * GB, override: null }), 2);
});

test('wasmRuntimeDir: a bundle reads bin/onnxruntime-web next to the server, everything else uses the package', () => {
  assert.equal(wasmRuntimeDir({ standalone: false, root: path.join('/opt', 'mstream') }), null);
  const dir = wasmRuntimeDir({ standalone: true, root: path.join('/opt', 'mstream') });
  assert.equal(dir, path.join('/opt', 'mstream', 'bin', 'onnxruntime-web') + path.sep);
  assert.ok(dir.endsWith(path.sep), 'onnxruntime-web concatenates file names onto the prefix — it needs the separator');
});

test('loadEmbeddingRuntime: auto falls back to wasm when native fails to import, and says why', async () => {
  const calls = [];
  const importers = {
    native: () => {
      calls.push('native');
      const e = new Error("Cannot find package 'onnxruntime-node' imported from /$bunfs/root/mstream");
      e.code = 'ERR_MODULE_NOT_FOUND';
      throw e;
    },
    wasm: () => { calls.push('wasm'); return { default: fakeOrt('wasm') }; },
  };
  const loaded = await loadEmbeddingRuntime({
    setting: 'auto', threads: 3, importers, standalone: false, wasmDir: null,
    createSession: (ort, opts) => ort.InferenceSession.create(null, opts),
  });
  assert.deepEqual(calls, ['native', 'wasm']);
  assert.equal(loaded.runtime, 'wasm');
  assert.equal(loaded.threads, 3);
  assert.equal(loaded.ort.env.wasm.numThreads, 3, 'the wasm thread count is applied to the runtime env');
  assert.equal(loaded.ort.env.wasm.wasmPaths, undefined, 'no path override outside a bundle');
  assert.deepEqual(loaded.sessionOptions, { executionProviders: ['wasm'] });
  assert.deepEqual(loaded.session, { name: 'wasm' });
  assert.deepEqual(loaded.skipped.map((s) => s.runtime), ['native']);
  assert.match(loaded.skipped[0].reason, /not installed or has no binary/);
});

test('loadEmbeddingRuntime: native wins in auto mode when it loads, with the thread cap as a session option', async () => {
  const importers = {
    native: () => ({ default: fakeOrt('native') }),
    wasm: () => { throw new Error('must not be tried'); },
  };
  const loaded = await loadEmbeddingRuntime({
    setting: 'auto', threads: 2, importers, standalone: false, wasmDir: null,
    createSession: (ort, opts) => ort.InferenceSession.create(null, opts),
  });
  assert.equal(loaded.runtime, 'native');
  assert.deepEqual(loaded.sessionOptions, { intraOpNumThreads: 2 });
  assert.deepEqual(loaded.skipped, []);
});

test('loadEmbeddingRuntime: a native import that cannot build a session still lands on wasm', async () => {
  const importers = {
    native: () => ({ default: fakeOrt('native', { createFails: true }) }),
    wasm: () => fakeOrt('wasm'),
  };
  const loaded = await loadEmbeddingRuntime({
    setting: 'auto', importers, standalone: false, wasmDir: null,
    createSession: (ort, opts) => ort.InferenceSession.create(null, opts),
  });
  assert.equal(loaded.runtime, 'wasm');
  assert.match(loaded.skipped[0].reason, /native cannot build a session/);
});

test('loadEmbeddingRuntime: a glibc-on-musl style dlopen failure is named as such', async () => {
  const importers = {
    native: () => {
      throw new Error('onnxruntime_binding.node is linked against glibc (DT_NEEDED libm.so.6), but this Bun build uses musl');
    },
    wasm: () => fakeOrt('wasm'),
  };
  const loaded = await loadEmbeddingRuntime({ setting: 'auto', importers, standalone: false, wasmDir: null });
  assert.equal(loaded.runtime, 'wasm');
  assert.match(loaded.skipped[0].reason, /cannot load its native binaries/);
});

test('loadEmbeddingRuntime: a forced runtime never falls back, and total failure is flagged dependencyMissing', async () => {
  const importers = {
    native: () => { throw new Error('nope'); },
    wasm: () => fakeOrt('wasm'),
  };
  await assert.rejects(
    loadEmbeddingRuntime({ setting: 'native', importers, standalone: false, wasmDir: null }),
    (err) => err.dependencyMissing === true
      && /no embedding runtime could be loaded/.test(err.message)
      && /native: nope/.test(err.message)
      && !/wasm:/.test(err.message)
      && err.skipped.length === 1);
});

test('loadEmbeddingRuntime: a bundle whose runtime files are missing says so instead of hanging', async () => {
  const importers = {
    native: () => { throw new Error('unused in a bundle'); },
    wasm: () => fakeOrt('wasm'),
  };
  const wasmDir = path.join(os.tmpdir(), `mstream-no-such-dir-${process.pid}`) + path.sep;
  await assert.rejects(
    loadEmbeddingRuntime({ setting: 'auto', importers, standalone: true, wasmDir }),
    (err) => err.dependencyMissing === true
      && /runtime files missing from/.test(err.message)
      && /ort-wasm-simd-threaded\.wasm/.test(err.message)
      && /ort-wasm-simd-threaded\.mjs/.test(err.message)
      && !/native/.test(err.message));
});

test('loadEmbeddingRuntime: the real onnxruntime-web package loads with the session API', async () => {
  const loaded = await loadEmbeddingRuntime({ setting: 'wasm', threads: 1, standalone: false, wasmDir: null });
  assert.equal(loaded.runtime, 'wasm');
  assert.equal(typeof loaded.ort.InferenceSession.create, 'function');
  assert.equal(typeof loaded.ort.Tensor, 'function');
  assert.equal(loaded.ort.env.wasm.numThreads, 1);
});
