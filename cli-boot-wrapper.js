#!/usr/bin/env node

// Must stay the first import: arms the console-loss watcher (see
// src/util/supervision.js) before any other module can write.
import { watchSupervisorStdin } from './src/util/supervision.js';
import { join } from 'path';
import { maybeRunWorker } from './src/util/worker-process.js';
import { detachForFinderLaunch } from './src/util/mac-app-launch.js';
import { appRoot } from './src/util/esm-helpers.js';
import pkg from './package.json' with { type: 'json' };

const version = pkg.version;

// Self-dispatched background worker: a Bun standalone binary re-invokes itself
// with --mstream-worker=<role> instead of forking a loose script. Run that
// worker and skip booting the server. (No-op under Node, which forks the real
// script files.)
if (await maybeRunWorker()) {
  // the worker module ran on import — nothing else to do
} else {
  // Default config lives next to the app: the repo root under Node, or the
  // binary's own directory under a Bun standalone build (appRoot resolves both).
  // MSTREAM_CONFIG overrides the default; an explicit -j/--json overrides that.
  const defaultJson = process.env.MSTREAM_CONFIG || join(appRoot, 'save/conf/default.json');
  const { json, supervised } = parseArgs(process.argv.slice(2), defaultJson);

  // Finder double-click (macOS .app only — a no-op everywhere else): hand
  // the real boot to a detached copy and exit, so LaunchServices doesn't
  // pin this process as "the app" and swallow later double-clicks. See
  // src/util/mac-app-launch.js for the whole desktop-launch story.
  if (detachForFinderLaunch()) {
    process.exit(0);
  }

  // Armed before the banner so a supervisor that died mid-boot still stops us.
  if (supervised) { watchSupervisorStdin(); }

  console.clear();
  console.log(`
               ____  _
     _ __ ___ / ___|| |_ _ __ ___  __ _ _ __ ___
    | '_ \` _ \\\\___ \\| __| '__/ _ \\/ _\` | '_ \` _ \\
    | | | | | |___) | |_| | |  __/ (_| | | | | | |
    |_| |_| |_|____/ \\__|_|  \\___|\\__,_|_| |_| |_|`);
  console.log(`v${version}`);
  console.log();
  console.log('Check out our Discord server:');
  console.log('https://discord.gg/AM896Rr');
  console.log();

  // Boot the server. serveIt can reject before the listen handler exists
  // (bad SSL certs, unexpected setup errors); without this catch that's an
  // unhandled rejection — a raw stack in a terminal, and total silence when
  // Finder launched the macOS .app (stdout is /dev/null there). Surface it,
  // and as a dialog on an app launch (see src/util/mac-app-launch.js).
  const server = await import("./src/server.js");
  server.serveIt(json).catch(async (err) => {
    console.error('mStream failed to start:', err);
    try {
      const { announceBootFailure } = await import('./src/util/mac-app-launch.js');
      announceBootFailure(`mStream could not start: ${err.message}`);
    } catch (_err) { /* feedback is best-effort — still exit nonzero */ }
    process.exit(1);
  });
}

function parseArgs(args, defaultJson) {
  let json = defaultJson;
  let supervised = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-V' || arg === '--version') {
      console.log(version);
      process.exit(0);
    }
    if (arg === '-h' || arg === '--help') {
      console.log(`Usage: mstream [options]

Options:
  -V, --version        output the version number
  -j, --json <json>    Specify JSON Boot File (default: ${defaultJson})
  --supervised         exit when the launching process closes stdin (for
                       supervisors that run mStream as a managed child and
                       hold its stdin pipe open)
  -h, --help           display help for command`);
      process.exit(0);
    }
    if (arg === '--supervised') {
      supervised = true;
      continue;
    }
    if (arg === '-j' || arg === '--json') {
      json = args[++i];
      if (json === undefined) {
        console.error(`error: option '${arg}' argument missing`);
        process.exit(1);
      }
      continue;
    }
    if (arg.startsWith('--json=')) {
      json = arg.slice('--json='.length);
      continue;
    }
    console.error(`error: unknown option '${arg}'`);
    process.exit(1);
  }
  return { json, supervised };
}
