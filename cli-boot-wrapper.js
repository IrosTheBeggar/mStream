#!/usr/bin/env node
"use strict";

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  return require("./mstream-electron.js");
}

const config = require("./modules/config/configure-commander.js").setup(process.argv);

// User ran a maintenance operation.  End the program
if (!config){ return; }

// Check for errors
if (config.error) {
  console.log(config.error);
  process.exit(1);
}

const colors = require('colors');
console.clear();
console.log(colors.red(`
             ____  _
   _ __ ___ / ___|| |_ _ __ ___  __ _ _ __ ___
  | '_ \` _ \\\\___ \\| __| '__/ _ \\/ _\` | '_ \` _ \\
  | | | | | |___) | |_| | |  __/ (_| | | | | | |
  |_| |_| |_|____/ \\__|_|  \\___|\\__,_|_| |_| |_|`));
console.log();
console.log(colors.bold.red('v5.0-alpha'));
console.log();
console.log('mStream Server is undergoing some changes.  Some things may break.  Please expect the following:')
console.log('-- CLI tools will be completely overhauled');
console.log('-- Config files changes.  Your old config files WILL become invalid.  There will be new UI and CLI tools to assist in the setup of new config files');
console.log('-- DB Structure Changes.  Your DB might be re-scanned at some point');
console.log();
console.log('v5 Updates:')
console.log('-- A New Admin Panel where you can set update server configurations');
console.log('-- Improved pipeline for compiling the Desktop version of mStream');
console.log('-- Fog Machine integration (https://fog.fm). FM is an optional feature to make mStream even easier to deploy');
console.log('-- A lot of code cleanup');
console.log();
console.log('Thanks for using mStream');
console.log('Paul Sori');
console.log();
console.log(colors.bold('Have questions about v5? Chat with me on Discord to find out more:'));
console.log(colors.bold('https://discord.gg/AM896Rr'));
console.log();

// Boot the server
const serve = require("./mstream.js");
serve.serveIt(config);
