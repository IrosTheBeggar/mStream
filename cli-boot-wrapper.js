#!/usr/bin/env node

import { join } from 'path';
import { maybeRunWorker } from './src/util/worker-process.js';
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
  const { json } = parseArgs(process.argv.slice(2), defaultJson);

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

  // Boot the server
  const server = await import("./src/server.js");
  server.serveIt(json);
}

function parseArgs(args, defaultJson) {
  let json = defaultJson;
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
  -h, --help           display help for command`);
      process.exit(0);
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
  return { json };
}
