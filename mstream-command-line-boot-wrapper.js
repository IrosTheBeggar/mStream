#!/usr/bin/env node
"use strict";

// Check if we are in an electron enviroment
if (process.versions["electron"]) {
  // off to a seperate electron boot enviroment
  require("./mstream-electron.js");
  return;
}

var program = require("./modules/config/configure-commander.js").setup(process.argv);

// User ran a miantnence operation.  End the program
if(!program){
  return;
}

// Check for errors
if (program.error) {
  console.log(program.error);
  process.exit(1);
  return;
}

// Boot the server
const serve = require("./mstream.js");
serve.serveit(program);
