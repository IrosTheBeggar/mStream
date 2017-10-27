#!/usr/bin/env node
"use strict";
const fe = require('path');
const fs = require('fs');

// Check if we are in an electron enviroment
if(process.versions['electron']){
  // off to a seperate electron boot enviroment
  require('./mstream-electron.js');
  return;
}

var program;
try{
  if(fe.extname(process.argv[process.argv.length-1]) === '.json'  &&  fs.statSync(process.argv[process.argv.length-1]).isFile()){
    let loadJson = JSON.parse(fs.readFileSync(process.argv[process.argv.length-1], 'utf8'));
    program =  require('./modules/configure-json-file.js').setup(loadJson, __dirname);
  }else{
    // User did not provide a JSON file
    program = require('./modules/configure-commander.js').setup(process.argv);
  }
}catch(error){
  // This condition is hit only if the user entered a json file as an argument and the file did not exist or is invalid JSON
  console.log("ERROR: Failed to parse JSON file");
  console.log(error);
  process.exit(1);
}

// Check for errors
if(program.error){
  console.log(program)
  console.log(program.error);
  process.exit(1);
}

// Boot the server
const serve = require('./mstream.js');
serve.serveit(program);
