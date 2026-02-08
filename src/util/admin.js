import fs from 'fs/promises';
import path from 'path';
import child from 'child_process';
import express from 'express';
import * as auth from './auth.js';
import * as config from '../state/config.js';
import * as mStreamServer from '../server.js';
import * as dbQueue from '../db/task-queue.js';
import * as logger from '../logger.js';
import * as db from '../db/manager.js';
import * as syncthing from '../state/syncthing.js';
import { getDirname } from './esm-helpers.js';

const __dirname = getDirname(import.meta.url);

export async function loadFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export async function saveFile(saveData, file) {
  return await fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8')
}

export async function addDirectory(directory, vpath, autoAccess, isAudioBooks, mstream) {
  // confirm directory is real
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw `${directory} is not a directory` };

  if (config.program.folders[vpath]) { throw `'${vpath}' is already loaded into memory`; }

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = JSON.parse(JSON.stringify(config.program.folders));
  memClone[vpath] = { root: directory };
  if (isAudioBooks) { memClone[vpath].type = 'audio-books'; }

  // add directory to config file
  const loadConfig = await loadFile(config.configFile);
  loadConfig.folders = memClone;
  if (autoAccess === true) {
    const memCloneUsers = JSON.parse(JSON.stringify(config.program.users));
    Object.values(memCloneUsers).forEach(user => {
      user.vpaths.push(vpath);
    });
    loadConfig.users = memCloneUsers;
  }
  await saveFile(loadConfig, config.configFile);

  // add directory to program
  config.program.folders[vpath] = memClone[vpath];

  if (autoAccess === true) {
    Object.values(config.program.users).forEach(user => {
      user.vpaths.push(vpath);
    });
  }

  // add directory to server routing
  mstream.use(`/media/${vpath}/`, express.static(directory));
}

export async function removeDirectory(vpath) {
  if (!config.program.folders[vpath]) { throw `'${vpath}' not found`; }

  const memCloneFolders = JSON.parse(JSON.stringify(config.program.folders));
  delete memCloneFolders[vpath];

  const memCloneUsers = JSON.parse(JSON.stringify(config.program.users));
  Object.values(memCloneUsers).forEach(user => {
    if (user.vpaths.includes(vpath)) {
      user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
    }
  });

  const loadConfig = await loadFile(config.configFile);
  loadConfig.folders = memCloneFolders;
  loadConfig.users = memCloneUsers;
  await saveFile(loadConfig, config.configFile);

  db.getFileCollection().findAndRemove({ 'vpath': { '$eq': vpath } });
  db.saveFilesDB();

  // reboot server
  mStreamServer.reboot();
}

export async function addUser(username, password, admin, vpaths) {
  if (config.program.users[username]) { throw `'${username}' is already loaded into memory`; }

  // hash password
  const hash = await auth.hashPassword(password);

  const newUser = {
    vpaths: vpaths,
    password: hash.hashPassword,
    salt: hash.salt,
    admin: admin
  };

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username] = newUser;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username] = newUser;

  // TODO: add user from scrobbler
}

export async function deleteUser(username) {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  delete memClone[username];

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  delete config.program.users[username];

  db.getUserMetadataCollection().findAndRemove({ 'user': { '$eq': username } });
  db.saveUserDB();

  db.getPlaylistCollection().findAndRemove({ 'user': { '$eq': username } });
  db.saveUserDB();

  db.getShareCollection().findAndRemove({ 'user': { '$eq': username } });
  db.saveUserDB();

  // TODO: Remove user from scrobbler
}

export async function editUserPassword(username, password) {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const hash = await auth.hashPassword(password);

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].password = hash.hashPassword;
  memClone[username].salt = hash.salt;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].password = hash.hashPassword;
  config.program.users[username].salt = hash.salt;
}

export async function editUserVPaths(username, vpaths) {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].vpaths = vpaths;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].vpaths = vpaths;
}

export async function editUserAccess(username, admin) {
  if (!config.program.users[username]) { throw `'${username}' does not exist`; }

  const memClone = JSON.parse(JSON.stringify(config.program.users));
  memClone[username].admin = admin;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].admin = admin;
}

export async function editPort(port) {
  if (config.program.port === port) { return; }

  const loadConfig = await loadFile(config.configFile);
  loadConfig.port = port;
  await saveFile(loadConfig, config.configFile);

  // reboot server
  mStreamServer.reboot();
}

export async function editMaxRequestSize(maxRequestSize) {
  if (config.program.maxRequestSize === maxRequestSize) { return; }

  const loadConfig = await loadFile(config.configFile);
  loadConfig.maxRequestSize = maxRequestSize;
  await saveFile(loadConfig, config.configFile);

  // reboot server
  mStreamServer.reboot();
}

export async function editUpload(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noUpload = val;
  await saveFile(loadConfig, config.configFile);

  config.program.noUpload = val;
}


export async function editAddress(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.address = val;
  await saveFile(loadConfig, config.configFile);

  mStreamServer.reboot();
}

export async function editSecret(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.secret = val;
  await saveFile(loadConfig, config.configFile);

  config.program.secret = val;
}

export async function editScanInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanInterval = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.scanInterval = val;

  // update timer
  dbQueue.resetScanInterval();
}

export async function editSaveInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.saveInterval = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.saveInterval = val;
}

export async function editSkipImg(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.skipImg = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.skipImg = val;
}

export async function editPause(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.pause = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.pause = val;
}

export async function editBootScanDelay(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanDelay = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.bootScanDelay = val;
}

export async function editMaxConcurrentTasks(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxConcurrentTasks = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.maxConcurrentTasks = val;
}

export async function editCompressImages(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.compressImage = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.compressImage = val;
}

export async function editWriteLogs(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await saveFile(loadConfig, config.configFile);

  config.program.writeLogs = val;

  if (val === false) {
    logger.reset();
  } else {
    logger.addFileLogger(config.program.storage.logsDirectory);
  }
}

export async function enableTranscode(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.enabled = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.enabled = val;
}

export async function editDefaultCodec(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultCodec = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultCodec = val;
}

export async function editDefaultBitrate(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultBitrate = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultBitrate = val;
}

export async function editDefaultAlgorithm(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.algorithm = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.algorithm = val;
}

export async function lockAdminApi(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.lockAdmin = val;
  await saveFile(loadConfig, config.configFile);

  config.program.lockAdmin = val;
}

export async function enableFederation(val) {
  const memClone = JSON.parse(JSON.stringify(config.program.federation));
  memClone.enabled = val;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.federation = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.federation.enabled = val;
  syncthing.setup();
}

export async function removeSSL() {
  const loadConfig = await loadFile(config.configFile);
  delete loadConfig.ssl;
  await saveFile(loadConfig, config.configFile);

  delete config.program.ssl;
  mStreamServer.reboot();
}

function testSSL(jsonLoad) {
  return new Promise((resolve, reject) => {
    child.fork(path.join(__dirname, './ssl-test.js'), [JSON.stringify(jsonLoad)], { silent: true }).on('close', (code) => {
      if (code !== 0) {
        return reject('SSL Failure');
      }
      resolve();
    });
  });
}

export async function setSSL(cert, key) {
  const sslObj = { key, cert };
  await testSSL(sslObj);
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ssl = sslObj;
  await saveFile(loadConfig, config.configFile);

  config.program.ssl = sslObj;
  mStreamServer.reboot();
}
