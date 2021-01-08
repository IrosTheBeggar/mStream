const fs = require("fs").promises;
const express = require('express');
const auth = require('./auth');
const config = require('../state/config');

exports.loadFile = async (file) => {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

exports.saveFile = async (saveData, file) => {
  return await fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8')
}

exports.addDirectory = async (directory, vpath, autoAccess, mstream) => {
  // confirm directory is real
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw `${directory} is not a directory` };

  if (config.program.folders[vpath]) { throw `'${vpath}' is already loaded into memory`; }

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = JSON.parse(JSON.stringify(config.program.folders));
  memClone[vpath] = { root: directory };

  // add directory to config file
  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.folders = memClone;
  if (autoAccess === true) {
    const memCloneUsers = JSON.parse(JSON.stringify(config.program.users));
    Object.values(memCloneUsers).forEach(user => {
      user.vpaths.push(vpath);
    });
    loadConfig.users = memCloneUsers;
  }
  await this.saveFile(loadConfig, config.configFile);

  // add directory to program
  config.program.folders[vpath] = { root: directory };

  if (autoAccess === true) {
    Object.values(config.program.users).forEach(user => {
      user.vpaths.push(vpath);
    });
  }

  // add directory to server routing
  mstream.use(`/media/${vpath}/`, express.static(directory));
}

exports.removeDirectory = async () => {

}

exports.addUser = async (username, password, admin, guest, vpaths) => {
  if (config.program.users[username]) { throw `'${username}' is already loaded into memory`; }
  
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
  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username] = newUser;

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  config.program.users[username] = newUser;
}

exports.deleteUser = async (username) => {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  delete memClone[username];

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  delete config.program.users[username]
}

exports.editUserPassword = async (username, password) => {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const hash = await auth.hashPassword(password);

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].password = hash.hashPassword;
  memClone[username].salt = hash.salt;

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  config.program.users[username].password = hash.hashPassword;
  config.program.users[username].salt = hash.salt;
}

exports.editUserVPaths = async (username, vpaths) => {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].vpaths = vpaths;

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  config.program.users[username].vpaths = vpaths;
}

exports.editUserAccess = async (username, admin, guest) => {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].guest = guest;
  memClone[username].admin = admin;

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  config.program.users[username].guest = guest;
  config.program.users[username].admin = admin;
}