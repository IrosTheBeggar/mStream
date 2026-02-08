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
  const { Command } = await import('commander');
  const program = new Command();
  program
    .version(version)
    .option('-j, --json <json>', 'Specify JSON Boot File', join(__dirname, 'save/conf/default.json'))
    .parse(process.argv);

  console.clear();
  console.log(`
               ____  _
     _ __ ___ / ___|| |_ _ __ ___  __ _ _ __ ___
    | '_ \` _ \\\\___ \\| __| '__/ _ \\/ _\` | '_ \` _ \\
    | | | | | |___) | |_| | |  __/ (_| | | | | | |
    |_| |_| |_|____/ \\__|_|  \\___|\\__,_|_| |_| |_|`);
  console.log(`v${program.version()}`);
  console.log();
  console.log('Check out our Discord server:');
  console.log('https://discord.gg/AM896Rr');
  console.log();

  // Boot the server
  const server = await import("./src/server.js");
  server.serveIt(program.opts().json);
}
