#!/usr/bin/env node
"use strict";
const fe = require("path");
const fs = require("fs");

// Check if we are in an electron enviroment
if (process.versions["electron"]) {
  // off to a seperate electron boot enviroment
  require("./mstream-electron.js");
  return;
}

var program = require("./modules/configure-commander.js").setup(process.argv);

// Check for errors
if (program.error) {
  console.log(program.error);
  process.exit(1);
  return;
}

// Boot the server
const serve = require("./mstream.js");
serve.serveit(program);
