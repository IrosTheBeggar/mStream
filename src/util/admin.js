const fs = require("fs").promises;
const express = require('express');

exports.loadFile = async function(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

exports.saveFile = async function(saveData, file) {
  return await fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8')
}

exports.addDirectory = async function(directory, vpath, configFile, program, mstream) {
  try {
    // confirm directory is real
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) { throw 'not a directory' };

    const config = await this.loadFile(configFile);
    config.folders[vpath] = { root: directory };

    await this.saveFile(config, configFile);

    program.folders[vpath] = { root: directory };

    if (mstream) {
      mstream.use(`/media/${vpath}/`, express.static(directory));
    }
  }catch (err) {
    throw err;
  }
}

exports.deleteDirectory = async function(vpath, configFile, program, mstream) {
}
