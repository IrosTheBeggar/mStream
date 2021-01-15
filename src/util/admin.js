const fs = require("fs").promises;
const path = require("path");
const express = require('express');
const auth = require('./auth');
const config = require('../state/config');
const mStreamServer = require('../../mstream');
const dbQueue = require('../db/task-queue');
const logger = require('../logger');

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

exports.removeDirectory = async (vpath) => {
  if (!config.program.folders[vpath]) { throw `'${vpath}' not found`; }

  const memCloneFolders = JSON.parse(JSON.stringify(config.program.folders));
  delete memCloneFolders[vpath];

  const memCloneUsers = JSON.parse(JSON.stringify(config.program.users));
  Object.values(memCloneUsers).forEach(user => {
    if (user.vpaths.includes(vpath)) {
      user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
    }
  });

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.folders = memCloneFolders;
  loadConfig.users = memCloneUsers;
  await this.saveFile(loadConfig, config.configFile);

  // reboot server
  mStreamServer.reboot();
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

  // TODO: add user from scrobbler
}

exports.deleteUser = async (username) => {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  delete memClone[username];

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.users = memClone;
  await this.saveFile(loadConfig, config.configFile);

  delete config.program.users[username];

  // TODO: Remove user from scrobbler
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

exports.editPort = async (port) => {
  if (config.program.port === port) { return; }

  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.port = port;
  await this.saveFile(loadConfig, config.configFile);

  // reboot server
  mStreamServer.reboot();
}

exports.editUpload = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.noUpload = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.noUpload = val;
}


exports.editAddress = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.address = val;
  await this.saveFile(loadConfig, config.configFile);

  mStreamServer.reboot();
}

exports.editSecret = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.secret = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.secret = val;
}

exports.editScanInterval = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanInterval = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.scanInterval = val;

  // update timer
  dbQueue.resetScanInterval();
}

exports.editSaveInterval = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.saveInterval = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.saveInterval = val;
}

exports.editSkipImg = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.skipImg = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.skipImg = val;
}

exports.editPause = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.pause = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.pause = val;
}

exports.editBootScanDelay = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanDelay = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.bootScanDelay = val;
}

exports.editMaxConcurrentTasks = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxConcurrentTasks = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.scanOptions.maxConcurrentTasks = val;
}

exports.editWriteLogs = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.writeLogs = val;

  if (val === false) {
    logger.reset();
  } else {
    logger.addFileLogger(config.program.storage.logsDirectory);
  }
}

exports.enableTranscode = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.enabled = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.transcode.enabled = val;
}

exports.editDefaultCodec = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultCodec = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultCodec = val;
}

exports.editDefaultBitrate = async (val) => {
  const loadConfig = await this.loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultBitrate = val;
  await this.saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultBitrate = val;
}
