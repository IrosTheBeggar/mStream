#!/usr/bin/env node
"use strict";

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  require("./build/electron");
} else {
  const program = require('commander');
  program
    .version(require('./package.json').version)
    .option('-j, --json <json>', 'Specify JSON Boot File', require('path').join(__dirname, 'save/conf/default.json'))
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
  require("./src/server").serveIt(program.opts().json);  
}
