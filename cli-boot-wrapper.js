#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const version = require('./package.json').version;

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  await import("./build/electron.js");
} else {
  const defaultJson = join(__dirname, 'save/conf/default.json');
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
