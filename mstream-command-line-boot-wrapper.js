#!/usr/bin/env node
"use strict";

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  require("./mstream-electron.js");
  return;
}

var program = require("./modules/config/configure-commander.js").setup(process.argv);

// User ran a maintenance operation.  End the program
if(!program){
  return;
}

// Check for errors
if (program.error) {
  console.log(program.error);
  process.exit(1);
  return;
}

// Beg
console.log(`
             ____  _                            
   _ __ ___ / ___|| |_ _ __ ___  __ _ _ __ ___  
  | '_ \` _ \\\\___ \\| __| '__/ _ \\/ _\` | '_ \` _ \\  
  | | | | | |___) | |_| | |  __/ (_| | | | | | |
  |_| |_| |_|____/ \\__|_|  \\___|\\__,_|_| |_| |_|
  Music Streaming Sever v3.9.1`);
console.log();
console.log('Donate:');
console.log('https://www.patreon.com/mstream');
console.log();
console.log('Find a bug? Report it at:');
console.log('https://github.com/IrosTheBeggar/mStream/issues');
console.log();
console.log('Developed by Paul Sori');
console.log('paul@mstream.io');
console.log();

// Boot the server
const serve = require("./mstream.js");
serve.serveit(program);
