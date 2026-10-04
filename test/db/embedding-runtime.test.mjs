// Runtime selection for the discovery-embedding model
// (src/db/embedding-runtime.js): which ONNX Runtime build is tried in which
// order, the thread cap, where a bundle finds the wasm files, and the
// fallback / failure contract — all with injected importers, so nothing here
// needs the native addon or the 18 MB model. The last test loads the real
// onnxruntime-web package (a regular dependency) to prove the API shape.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  planRuntimes, threadPolicy, wasmRuntimeDir, loadEmbeddingRuntime, EMBEDDING_RUNTIMES,
  probeNativeRuntime, nativeModuleUrl, NATIVE_PROBE_TIMEOUT_MS,
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

// ── The out-of-process probe of the native addon ────────────────────────────
//
// The addon can segfault inside its import (an older libonnxruntime under a
// newer binding — the linuxserver Docker image's shape), which no in-process
// fallback survives. Auto mode therefore probes it in a child first. The
// loader's half is tested with an injected probe; probeNativeRuntime itself
// against real child processes running throwaway stand-in modules.

const CRASH_VERDICT = {
  safe: false, ok: false,
  reason: 'the addon crashed while loading (SIGSEGV): The requested API version [29] is not available',
};

test('loadEmbeddingRuntime: auto probes the native addon out of process first; a crash verdict skips it and lands on wasm', async () => {
  const probes = [];
  const importers = {
    native: () => { throw new Error('must not be imported in-process after a crash verdict'); },
    wasm: () => fakeOrt('wasm'),
  };
  const loaded = await loadEmbeddingRuntime({
    setting: 'auto', threads: 2, importers, standalone: false, wasmDir: null,
    probeModelPath: path.join('/models', 'effnet.onnx'),
    resolveNative: () => 'file:///fake/node_modules/onnxruntime-node/dist/index.js',
    probe: (opts) => { probes.push(opts); return CRASH_VERDICT; },
    createSession: (ort, opts) => ort.InferenceSession.create(null, opts),
  });
  assert.equal(loaded.runtime, 'wasm');
  assert.deepEqual(loaded.skipped, [{ runtime: 'native', reason: CRASH_VERDICT.reason }]);
  // The probe exercises what the worker is about to do: the resolved entry
  // file, the real model, the same thread option, the default timeout.
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0], {
    moduleUrl: 'file:///fake/node_modules/onnxruntime-node/dist/index.js',
    modelPath: path.join('/models', 'effnet.onnx'),
    threads: 2,
    timeoutMs: NATIVE_PROBE_TIMEOUT_MS,
  });
});

test('loadEmbeddingRuntime: a safe verdict leaves the in-process import in charge, whichever way it goes', async () => {
  // ok: native loads in-process and wins.
  let loaded = await loadEmbeddingRuntime({
    setting: 'auto', importers: { native: () => fakeOrt('native'), wasm: () => { throw new Error('unused'); } },
    standalone: false, wasmDir: null, resolveNative: () => 'file:///fake/index.js',
    probe: () => ({ safe: true, ok: true }),
    createSession: (ort, opts) => ort.InferenceSession.create(null, opts),
  });
  assert.equal(loaded.runtime, 'native');
  assert.deepEqual(loaded.skipped, []);

  // An ordinary error in the probe is not acted on: the in-process import
  // reproduces it and the usual diagnosis names it.
  loaded = await loadEmbeddingRuntime({
    setting: 'auto',
    importers: {
      native: () => { const e = new Error("Cannot find package 'onnxruntime-node'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; },
      wasm: () => fakeOrt('wasm'),
    },
    standalone: false, wasmDir: null, resolveNative: () => 'file:///fake/index.js',
    probe: () => ({ safe: true, ok: false, error: "Cannot find package 'onnxruntime-node'" }),
  });
  assert.equal(loaded.runtime, 'wasm');
  assert.match(loaded.skipped[0].reason, /not installed or has no binary/);
});

test('loadEmbeddingRuntime: no probe when native is forced, inside a bundle, with the addon absent, or when disabled', async () => {
  let probes = 0;
  const probe = () => { probes++; return CRASH_VERDICT; };
  const nativeOk = { native: () => fakeOrt('native'), wasm: () => fakeOrt('wasm') };
  const resolveNative = () => 'file:///fake/index.js';

  // Forced native: a crash is meant to be loud, so it is not probed around.
  let loaded = await loadEmbeddingRuntime({ setting: 'native', importers: nativeOk, standalone: false, wasmDir: null, probe, resolveNative });
  assert.equal(loaded.runtime, 'native');
  // A bundle plans wasm only — nothing native to probe.
  loaded = await loadEmbeddingRuntime({ setting: 'auto', importers: nativeOk, standalone: true, wasmDir: null, probe, resolveNative });
  assert.equal(loaded.runtime, 'wasm');
  // Not installed: resolution throws, and the in-process import says why.
  loaded = await loadEmbeddingRuntime({
    setting: 'auto', standalone: false, wasmDir: null, probe,
    resolveNative: () => { throw new Error("Cannot find module 'onnxruntime-node'"); },
    importers: {
      native: () => { const e = new Error("Cannot find package 'onnxruntime-node'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; },
      wasm: () => fakeOrt('wasm'),
    },
  });
  assert.equal(loaded.runtime, 'wasm');
  assert.match(loaded.skipped[0].reason, /not installed or has no binary/);
  // Disabled outright.
  loaded = await loadEmbeddingRuntime({ setting: 'auto', importers: nativeOk, standalone: false, wasmDir: null, probe: false, resolveNative });
  assert.equal(loaded.runtime, 'native');

  assert.equal(probes, 0);
});

// Stand-in "addons" for the real-process probe tests: throwaway ES modules
// written to a temp dir and imported by the probe child through their
// file:// URL, exactly as the resolved onnxruntime-node entry would be.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ort-probe-'));
after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
function fixture(name, source) {
  const file = path.join(fixtureDir, name);
  fs.writeFileSync(file, source);
  return pathToFileURL(file).href;
}
// Die the way a native crash does: by signal where there are signals, by an
// NTSTATUS exit code on Windows (0xC0000005 = access violation). kill() is
// asynchronous, so the module parks itself until the signal lands.
const DIE = `
  if (process.platform === 'win32') { process.exit(0xC0000005); }
  process.kill(process.pid, 'SIGSEGV');
  await new Promise(() => {});
`;
const ORT_SKEW_LINE = 'The requested API version [29] is not available, only API versions [1, 24] are supported in this build. Current ORT Version is: 1.24.4';

test('probeNativeRuntime: a module that kills its process on import is reported as a crash, with its stderr and the version-skew hint', async () => {
  const moduleUrl = fixture('crash-on-import.mjs', `
    import fs from 'node:fs';
    fs.writeSync(2, ${JSON.stringify(`${ORT_SKEW_LINE}\n`)});
    ${DIE}
  `);
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1 });
  assert.equal(verdict.safe, false);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^the addon crashed while loading \((SIGSEGV|exit code \d+)\): /);
  assert.ok(verdict.reason.includes(ORT_SKEW_LINE), `stderr tail carried through: ${verdict.reason}`);
  assert.match(verdict.reason, /newer than the ONNX Runtime library it loaded at run time/);
});

// The real crash point: with a mismatched library the import returns normally
// and the FIRST session build segfaults (measured on Windows and Alpine), so
// a probe must reach a session build to be worth anything.
const CRASH_ON_CREATE = `
  import fs from 'node:fs';
  export const InferenceSession = {
    create(model, opts) {
      const shape = typeof model === 'string' ? model : (model instanceof Uint8Array ? 'bytes[' + model.length + ']' : typeof model);
      fs.writeSync(2, 'create(' + shape + ', ' + JSON.stringify(opts) + ') went down\\n');
      ${DIE.replace('await new Promise(() => {});', 'return new Promise(() => {});')}
    },
  };
`;

test('probeNativeRuntime: a crash while building the session is caught, and the model + threads reach the stand-in', async () => {
  const moduleUrl = fixture('crash-on-create.mjs', CRASH_ON_CREATE);
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: 'effnet.onnx', threads: 3 });
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /crashed while loading/);
  assert.ok(verdict.reason.includes('create(effnet.onnx, {"intraOpNumThreads":3}) went down'), verdict.reason);
  assert.doesNotMatch(verdict.reason, /newer than the ONNX Runtime library/, 'no skew hint without the sentinel line');
});

test('probeNativeRuntime: with no model the probe still builds a session, on its built-in one-op model', async () => {
  const moduleUrl = fixture('crash-on-create-no-model.mjs', CRASH_ON_CREATE);
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1 });
  assert.equal(verdict.safe, false, 'an import-only probe would have called this pairing safe');
  assert.ok(verdict.reason.includes('create(bytes[88], {"intraOpNumThreads":1}) went down'), verdict.reason);
});

test('probeNativeRuntime: a well-behaved module is safe, and the session is built on the given model or on the built-in bytes', async () => {
  const moduleUrl = fixture('ok.mjs', `
    import fs from 'node:fs';
    export const InferenceSession = {
      async create(model, opts) {
        const expected = typeof model === 'string'
          ? (model === 'effnet.onnx' && opts.intraOpNumThreads === 2)
          : (model instanceof Uint8Array && model.length === 88 && opts.intraOpNumThreads === 7);
        if (!expected) { throw new Error('unexpected create(' + String(model) + ', ' + JSON.stringify(opts) + ')'); }
        fs.writeSync(1, 'noise on stdout that is not a verdict\\n');
        return { release: async () => { fs.writeSync(1, '{"ok":"not a verdict either"}\\n'); } };
      },
    };
  `);
  assert.deepEqual(await probeNativeRuntime({ moduleUrl, modelPath: 'effnet.onnx', threads: 2 }), { safe: true, ok: true });
  assert.deepEqual(await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 7 }), { safe: true, ok: true });
});

test('probeNativeRuntime: the built-in model is a real ONNX graph — the real WebAssembly runtime builds a session on it', async () => {
  // onnxruntime-web is a regular dependency, so this runs everywhere the
  // suite does; it proves the 88 bytes parse as a model, not just as JSON-free
  // noise the stand-ins above happen to accept.
  const verdict = await probeNativeRuntime({ moduleUrl: import.meta.resolve('onnxruntime-web'), modelPath: null, threads: 1 });
  assert.deepEqual(verdict, { safe: true, ok: true });
});

test('probeNativeRuntime: an ordinary load error is passed back as such, not as a crash', async () => {
  const moduleUrl = fixture('throws.mjs', `
    throw new Error('Error relocating libonnxruntime.so.1: fcntl64: symbol not found');
  `);
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1 });
  assert.deepEqual(verdict, { safe: true, ok: false, error: 'Error relocating libonnxruntime.so.1: fcntl64: symbol not found' });
});

test('probeNativeRuntime: a load that hangs is killed at the timeout and counts as unsafe', async () => {
  // A timer holds the child's event loop open the way a stuck native thread
  // would, so only the parent's timeout can end it.
  const moduleUrl = fixture('hangs.mjs', 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n');
  const started = Date.now();
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1, timeoutMs: 1000 });
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /did not finish loading within 1 s \(the probe was killed\)/);
  assert.ok(Date.now() - started < 10000, 'the kill is prompt');
});

test('probeNativeRuntime: an import that never settles but lets the process drain is unsafe too, and not called a crash', async () => {
  const moduleUrl = fixture('drains.mjs', 'await new Promise(() => {});\n');
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1 });
  assert.deepEqual(verdict, {
    safe: false, ok: false,
    reason: "the addon's load never completed (the probe exited without a verdict)",
  });
});

test('probeNativeRuntime: a probe that cannot start proves nothing and is reported as safe', async () => {
  const verdict = await probeNativeRuntime({
    moduleUrl: 'file:///unused.mjs',
    fork: () => { throw new Error('spawn EACCES'); },
  });
  assert.deepEqual(verdict, { safe: true, ok: false, error: 'the probe could not start: spawn EACCES' });
});

test('probeNativeRuntime: the real onnxruntime-node addon never takes the probe process down here', async (t) => {
  let moduleUrl;
  try {
    moduleUrl = nativeModuleUrl();
  } catch (_err) {
    t.skip('onnxruntime-node is not installed');
    return;
  }
  assert.match(moduleUrl, /^file:\/\/.*onnxruntime-node[\\/]dist[\\/]index\.js$/);
  // No model path: the probe builds its session on the built-in model, so
  // this exercises the exact step that kills a mismatched pairing.
  const verdict = await probeNativeRuntime({ moduleUrl, modelPath: null, threads: 1 });
  // Platforms without a binary (Intel Macs) get an ordinary error; a crash
  // would mean this checkout's addon is broken the Docker way.
  assert.equal(verdict.safe, true, JSON.stringify(verdict));
});
