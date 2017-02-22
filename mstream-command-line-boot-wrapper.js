#!/usr/bin/env node
"use strict";

// Get the server config
const program = require('./modules/configure-json-file.js').setup(process.argv, __dirname);
if(program.error){
  console.log(program.error);
  process.exit();
}

const serve = require('./mstream.js');
serve(program);
