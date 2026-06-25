// Runtime-switched SQLite driver.
//
// Bun has no `node:sqlite`, so under Bun we use a bun:sqlite-backed shim; under
// Node we use the real node:sqlite. The `node:sqlite` specifier is built by
// concatenation so Bun's `--compile` bundler does not try (and fail) to resolve
// a module that doesn't exist in Bun. Node never takes the Bun branch and vice
// versa, so neither runtime ever loads the other's driver.
let DatabaseSync;
if (globalThis.Bun) {
  ({ DatabaseSync } = await import('./bun-sqlite-adapter.js'));
} else {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  ({ DatabaseSync } = require('node:' + 'sqlite'));
}
export { DatabaseSync };
