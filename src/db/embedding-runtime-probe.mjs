// Throwaway process that loads the native ONNX Runtime addon (onnxruntime-node)
// and builds one session on it — so that a load that KILLS its process takes
// this process down instead of the embedding worker.
//
// The addon can die without ever throwing: its module initialiser fetches the
// ONNX Runtime C API for the version it was built against and keeps the
// result unchecked. With an older libonnxruntime underneath it (the
// linuxserver Docker image swaps the bundled library for Alpine's, which lags
// the npm package) ORT prints "The requested API version [29] is not
// available …" to stderr during the import, the import then RETURNS NORMALLY,
// and the first InferenceSession.create dereferences the null pointer and
// segfaults (measured 2026-10-04: Windows 1.29 binding + 1.24.3 DLL, and
// Alpine 3.24 + gcompat + the distro 1.24.4 library). No try/catch can see
// that, which is why src/db/embedding-runtime.js runs this probe out of
// process before importing the addon in-process (auto mode only — a forced
// 'native' fails loudly by design), and reads one verdict line from stdout:
//
//   {"ok":true}                      safe to load in-process
//   {"ok":false,"error":"<message>"} the addon threw — an ordinary load
//                                    failure the worker reproduces in-process
//   (no verdict at all)              the process died (a crash), hung until
//                                    the parent killed it, or drained its
//                                    event loop with the import unsettled
//
// Payload = the LAST argv element, JSON: { moduleUrl, modelPath, threads } —
// the worker-script convention (src/util/worker-process.js). `moduleUrl` is
// the addon's entry file as a file:// URL (resolved by the parent, so this
// script needs no package resolution of its own); `modelPath` is the model
// to build the session on, or null for the built-in one below; `threads`
// mirrors the session option the worker will use.

// A complete ONNX model in 88 bytes — Identity on one float (ir_version 7,
// opset 13) — so the probe ALWAYS reaches a session build, which is where a
// mismatched library actually kills the process; an import-only probe would
// pass that pairing as safe. The real model is preferred when the caller has
// one, since it also proves the library can read THAT graph.
const BUILT_IN_MODEL = 'CAcSDW1zdHJlYW0tcHJvYmU6PwoUCgF4EgF5GgJpZCIISWRlbnRpdHkSBXByb2JlWg8KAXgSCgoICAESBAoCCAFiDwoBeRIKCggIARIECgIIAUIECgAQDQ==';

function finish(verdict, code) {
  // The verdict must survive the exit: pipe writes are asynchronous on
  // Windows and macOS, so exit from the write callback, never before it.
  process.stdout.write(`${JSON.stringify(verdict)}\n`, () => process.exit(code));
}

let payload = null;
try {
  payload = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_err) {
  finish({ ok: false, error: 'probe payload is not JSON' }, 2);
}

if (payload) {
  (async () => {
    const mod = await import(payload.moduleUrl);
    // CommonJS interop: onnxruntime-node's API object arrives as `default`.
    const ort = mod?.default?.InferenceSession ? mod.default : mod;
    const model = payload.modelPath || Uint8Array.from(Buffer.from(BUILT_IN_MODEL, 'base64'));
    const session = await ort.InferenceSession.create(model, {
      intraOpNumThreads: payload.threads || 1,
    });
    if (typeof session?.release === 'function') { await session.release(); }
  })().then(
    () => finish({ ok: true }, 0),
    (err) => finish({ ok: false, error: String(err?.message || err) }, 2),
  );
}
