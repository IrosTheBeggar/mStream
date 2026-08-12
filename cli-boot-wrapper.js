#!/usr/bin/env node

// Must stay the first import: arms the console-loss watcher (see
// src/util/supervision.js) before any other module can write.
import { watchSupervisorStdin } from './src/util/supervision.js';
import { maybeRunWorker } from './src/util/worker-process.js';
import { resolveDefaultConfig, ensureDesktopDefaultConfig } from './src/util/boot-config.js';
import pkg from './package.json' with { type: 'json' };

const version = pkg.version;

// Self-dispatched background worker: a Bun standalone binary re-invokes itself
// with --mstream-worker=<role> instead of forking a loose script. Run that
// worker and skip booting the server. (No-op under Node, which forks the real
// script files.)
if (await maybeRunWorker()) {
  // the worker module ran on import — nothing else to do
} else {
  // Where the default config lives depends on the install profile (see
  // src/util/boot-config.js): source/npm runs keep appRoot/save/conf/...
  // (falling back to the user data dir only when the app dir is read-only —
  // a translocated macOS .app being the case that matters); a standalone
  // binary uses the per-OS user data home unless a legacy next-to-binary
  // config exists or --portable asks to stay there.
  // MSTREAM_CONFIG overrides the default; an explicit -j/--json overrides that.
  // --portable is pre-scanned because it changes WHERE the default resolves,
  // which the parser needs for its help text.
  const resolved = resolveDefaultConfig({ portable: process.argv.includes('--portable') });
  const { json, supervised, quickConnectOffByDefault } = parseArgs(process.argv.slice(2), resolved.path);

  // First run of a standalone binary with no explicit config: create the
  // desktop-profile config (storage under the data home, Quick Connect on
  // unless --quick-connect-off-by-default) before setup() reads it.
  let createdConfig = false;
  if (json === resolved.path) {
    try {
      createdConfig = await ensureDesktopDefaultConfig(resolved, { quickConnectOffByDefault });
    } catch (err) {
      console.error(`Could not create the default config at ${resolved.path}: ${err.message}`);
      process.exit(1);
    }
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
  if (createdConfig) {
    console.log(`First run - created default config: ${resolved.path}`);
    console.log();
  }

  // Boot the server. serveIt can reject before the listen handler exists
  // (bad SSL certs, unexpected setup errors); without this catch that's an
  // unhandled rejection — a raw stack instead of a clean message + exit code.
  // Desktop launches get their user-visible dialog from the LAUNCHER, which
  // watches this process and reads its log (rust-launcher/).
  const server = await import("./src/server.js");
  server.serveIt(json).catch((err) => {
    console.error('mStream failed to start:', err);
    process.exit(1);
  });
}

function parseArgs(args, defaultJson) {
  let json = defaultJson;
  let supervised = false;
  let quickConnectOffByDefault = false;
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
  --portable           standalone binaries only: keep config + data next to
                       the binary (save/conf/...) instead of the per-user data
                       directory. An install that already has a config next to
                       the binary stays portable automatically.
  --quick-connect-off-by-default
                       standalone binaries only: when creating the first-run
                       config, leave Quick Connect (remote access) disabled.
                       Only shapes that generated default - an existing
                       config, including one where you enabled Quick Connect
                       yourself, is never changed.
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
    if (arg === '--portable') {
      // Consumed by the pre-scan in the boot block (it must influence where
      // the default config resolves, before parsing); accepted here so it
      // isn't rejected as an unknown option.
      continue;
    }
    if (arg === '--quick-connect-off-by-default') {
      quickConnectOffByDefault = true;
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
  return { json, supervised, quickConnectOffByDefault };
}
