#!/usr/bin/env bun
// Minimal non-Electron entry for the Bun --compile experiment.
// Mirrors the `else` branch of cli-boot-wrapper.js (CLI server boot) but never
// imports build/electron.js, so the bundler doesn't try to resolve `electron`.
import { maybeRunWorker } from './src/util/worker-process.js';

// Config path resolution: MSTREAM_CONFIG env, then `-j/--json <path>` (matching
// cli-boot-wrapper.js), then ./mstream-config.json relative to cwd.
function resolveConfigPath() {
  if (process.env.MSTREAM_CONFIG) { return process.env.MSTREAM_CONFIG; }
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-j' || args[i] === '--json') { return args[i + 1]; }
    if (args[i].startsWith('--json=')) { return args[i].slice('--json='.length); }
  }
  return 'mstream-config.json';
}

// Self-dispatch: when the binary is re-invoked as a background worker
// (--mstream-worker=<role>), run that worker instead of booting the server.
if (!(await maybeRunWorker())) {
  const server = await import('./src/server.js');
  const configPath = resolveConfigPath();
  console.log('[bun-entry] booting mStream server with config:', configPath);
  server.serveIt(configPath).catch((err) => {
    console.error('[bun-entry] fatal boot error:', err);
    process.exit(1);
  });
}
