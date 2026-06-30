// Self-dispatch worker launcher + dispatcher.
//
// Under Node/Electron, background workers run as `child.fork(scriptFile)`. That
// cannot work inside a Bun `--compile` standalone binary: fork() ignores the
// script path and re-runs the embedded entrypoint. So under Bun we re-invoke the
// binary itself with a `--mstream-worker=<role>` flag, and the entry's
// maybeRunWorker() prologue dispatches to the right worker module. Payload
// passing (workers read the LAST argv element) and the stdout/stderr line
// protocol are identical either way, so the worker scripts are unchanged.
import child from 'node:child_process';
import { isBunStandalone } from './esm-helpers.js';

export const WORKER_FLAG_PREFIX = '--mstream-worker=';

// Spawn a background worker. `role` selects the worker under Bun self-dispatch;
// `scriptPath` is the loose .mjs/.js file forked under Node/Electron. Returns a
// ChildProcess with piped stdout/stderr and no IPC channel — workers communicate
// over the stdout line protocol — matching child.fork({ silent: true }).
export function launchWorker(role, scriptPath, payload, extraOpts = {}) {
  if (isBunStandalone) {
    return child.spawn(process.execPath, [`${WORKER_FLAG_PREFIX}${role}`, payload],
      { stdio: ['ignore', 'pipe', 'pipe'], ...extraOpts });
  }
  return child.fork(scriptPath, [payload], { silent: true, ...extraOpts });
}

// The command-line marker the boot reaper (scan-pidfile.js) matches to prove a
// live pid is really our worker before killing it. Under Bun self-dispatch the
// child's command line is `<exe> --mstream-worker=<role> <payload>`, so the role
// flag is the marker; under Node it's the forked script path, as before.
export function workerReaperMarker(role, scriptPath) {
  return isBunStandalone ? `${WORKER_FLAG_PREFIX}${role}` : scriptPath;
}

// Entry prologue. If this process was launched as a self-dispatched worker,
// import+run the matching worker module (each reads its payload from argv and
// runs on import) and return true so the caller skips booting the server.
// Imports MUST be static string literals so Bun's bundler embeds every worker
// module into the standalone binary.
export async function maybeRunWorker(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith(WORKER_FLAG_PREFIX));
  if (!flag) { return false; }
  const role = flag.slice(WORKER_FLAG_PREFIX.length);
  switch (role) {
    case 'scanner':        await import('../db/scanner.mjs'); break;
    case 'albumart':       await import('../db/album-art-backfill.mjs'); break;
    case 'lyrics':         await import('../db/lyrics-backfill.mjs'); break;
    case 'audioanalysis':  await import('../db/audio-analysis-backfill.mjs'); break;
    case 'backup':         await import('../backup/worker.mjs'); break;
    case 'image-compress': await import('../db/image-compress-script.js'); break;
    case 'ssl-test':       await import('./ssl-test.js'); break;
    case 'iroh-selftest':  await import('./iroh-selftest.js'); break;
    default:
      console.error(`Unknown mStream worker role: ${role}`);
      process.exit(1);
  }
  return true;
}
