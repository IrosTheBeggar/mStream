const fs = require("fs").promises;
const express = require('express');
const auth = require('./auth');

exports.loadFile = async (file) => {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

exports.saveFile = async (saveData, file) => {
  return await fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8')
}

exports.addDirectory = async (directory, vpath, program, mstream) => {
  // confirm directory is real
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw `${directory} is not a directory` };

  if (program.folders[vpath]) { throw `'${vpath}' is already loaded into memory`; }

  // add directory to config file
  const config = await this.loadFile(program.configFile);
  config.folders[vpath] = { root: directory };
  await this.saveFile(config, program.configFile);

  // add directory to program
  program.folders[vpath] = { root: directory };

  // add directory to server routing
  mstream.use(`/media/${vpath}/`, express.static(directory));
}

exports.addUser = async (username, password, admin, guest, vpaths, program) => {
  if (program.users[username]) { throw `'${username}' is already loaded into memory`; }
  
  // hash password
  const hash = await auth.hashPassword(password);

  const newUser = {
    vpaths: vpaths,
    password: hash.hashPassword,
    salt: hash.salt,
    admin: admin,
    guest: guest
  };

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = JSON.parse(JSON.stringify(program.users));
  memClone[username] = newUser;

  const config = await this.loadFile(program.configFile);
  config.users = memClone;
  await this.saveFile(config, program.configFile);

  program.users[username] = newUser;
}
