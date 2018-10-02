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
console.log();
console.log('Donate to our Patreon:');
console.log('https://www.patreon.com/mstream');
console.log();

// Boot the server
const serve = require("./mstream.js");
serve.serveit(program);
