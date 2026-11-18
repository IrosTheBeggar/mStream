/**
 * Lazy `archiver` loader.
 *
 * archiver is a leaf: nothing needs it until someone actually asks for a zip
 * (playlist/directory/file downloads, and the admin log bundle). Importing it
 * at module scope put it on the BOOT path of every mStream process — measured
 * ~320-400ms warm, ~1.5s cold — and the server pays that whether or not a zip
 * is ever requested. The test suite pays it on every one of its ~100 server
 * boots, which is what surfaced it.
 *
 * Resolved once and cached, so only the first zip request pays the import.
 *
 * BUNDLING NOTE — the reason this is a shared module rather than two inline
 * `await import()`s: the specifier must stay a LITERAL STRING so Bun's bundler
 * statically resolves it and includes archiver in the standalone binary.
 * `bun build --compile` does not resolve packages at runtime (see the
 * --external onnxruntime-node note in scripts/build-bun.mjs: a standalone
 * binary can't load a package that wasn't bundled), so a computed specifier
 * here would build fine and then fail on the first download in a release
 * build. Keep the string literal, and keep archiver OUT of build-bun's
 * --external list.
 */

let cached = null;

/**
 * The ZipArchive constructor. Throws if archiver cannot be loaded — callers
 * await this at the TOP of their handler so that failure surfaces as a clean
 * error on the first zip request, attributable to this import, rather than
 * from somewhere deeper in the response path.
 */
export async function getZipArchive() {
  if (cached) { return cached; }
  const mod = await import('archiver');
  const ctor = mod.ZipArchive ?? mod.default?.ZipArchive;
  if (typeof ctor !== 'function') {
    throw new Error('archiver loaded but has no ZipArchive export');
  }
  cached = ctor;
  return cached;
}
