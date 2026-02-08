import os from 'os';
import fs from 'fs';
import { nanoid } from 'nanoid';
import winston from 'winston';
import path from 'path';
import { spawn } from 'child_process';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import axios from 'axios';
import https from 'https';
import kill from 'tree-kill';
import * as killQueue from './kill-list.js';
import * as config from './config.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

const parser = new XMLParser({ ignoreAttributes: false });
const platform = os.platform();
const osMap = {
  "win32": "syncthing.exe",
  "darwin": "syncthing-osx",
  "linux": "syncthing-linux",
  "android": "syncthing-android"
};

let spawnedProcess;

let xmlObj; // Syncthing XML Config
let myId; // Syncthing Device ID
const cacheObj = {};
let uiAddress;

killQueue.addToKillQueue(
  () => {
    // kill all workers
    if(spawnedProcess) {
      kill(spawnedProcess.pid);
    }
  }
);

export function getXml() {
  return xmlObj;
}

export function getId() {
  return myId;
}

export function getUiAddress() {
  if (typeof uiAddress !== 'string') { throw new Error('Syncthing UI Address Not Set'); }
  return uiAddress;
}

export function getPathId(path) {
  return cacheObj[path];
}

// TODO: change this for server reboot
export async function setup() {
  if (config.program.federation.enabled === false) { return kill2(); }

  try {
    await getSyncthingId();
    loadConfig();
  } catch (_err) {
    // if we fail to get the ID, we might need to init
    try {
      await initSyncthingConfig();
      loadConfig();
      await getSyncthingId();
      // remove default folder
      removeFoldersFromConfig();
      firstTimeConfig();
      addFoldersToConfig();
      saveIt();
    }catch (err) {
      return winston.error('Failed To Boot Syncthing', { stack: err });
    }
  }

  bootProgram();
}

let preventRebootFlag = false;
export function kill2() {
  if(spawnedProcess) {
    preventRebootFlag = true;
    kill(spawnedProcess.pid);
    spawnedProcess = undefined;
    myId = undefined;
    xmlObj = undefined;
  }
}

function initSyncthingConfig() {
  return new Promise((resolve, reject) => {
    const newProcess = spawn(path.join(__dirname, `../../bin/syncthing/${osMap[platform]}`), [`--generate=${config.program.storage.syncConfigDirectory}`], {});

    newProcess.stdout.on('data', (data) => {
      winston.info(`SYNCTHING: ${`${data}`.trim()}`);
    });

    newProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    newProcess.on('close', (code) => {
      if (code !== 0) {
        winston.error('Syncthing: Failed to setup new directory');
        return reject('Syncthing init failed');
      }
      resolve();
    });
  });
}

function getSyncthingId() {
  return new Promise((resolve, reject) => {
    const newProcess = spawn(path.join(__dirname, `../../bin/syncthing/${osMap[platform]}`), ['--home', config.program.storage.syncConfigDirectory, `--device-id`], {});

    newProcess.stdout.on('data', (data) => {
      myId = `${data}`.trim();
    });

    newProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    newProcess.on('close', (code) => {
      if (code !== 0) {
        winston.error('SyncThing: Failed to setup new directory');
        return reject('Get Syncthing ID failed');
      }
      resolve();
    });
  });
}

function loadConfig() {
  xmlObj = parser.parse(fs.readFileSync(path.join(config.program.storage.syncConfigDirectory, 'config.xml'), 'utf8'));

  // convert objects to arrays
  if (typeof xmlObj.configuration.folder === 'object' && !(xmlObj.configuration.folder instanceof Array)) {
    xmlObj.configuration.folder = [xmlObj.configuration.folder];
  } else if (typeof xmlObj.configuration.folder !== 'object') {
    xmlObj.configuration.folder = [];
  }

  // convert objects to arrays
  if (typeof xmlObj.configuration.device === 'object' && !(xmlObj.configuration.device instanceof Array)) {
    xmlObj.configuration.device = [xmlObj.configuration.device];
  } else if (typeof xmlObj.configuration.device !== 'object') {
    xmlObj.configuration.device = [];
  }

  // cache paths
  xmlObj.configuration.folder.forEach(folderObj => {
    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // get UI address
  uiAddress = xmlObj.configuration.gui.address;
}

function removeFoldersFromConfig() {
  // Removes all folders
  xmlObj.configuration.folder = xmlObj.configuration.folder.filter(folder => {
    return !!config.program.folders[folder['@_label']]
  });
}

function firstTimeConfig() {
  // we need the API to comes with the GUI
  xmlObj.configuration.gui['@_enabled'] = 'true';
  xmlObj.configuration.gui.theme = 'dark';

  // edit machine name
}

function addFoldersToConfig() {
  const xmlFolderMapper = {};
  xmlObj.configuration.folder.forEach(folderObj => {
    xmlFolderMapper[folderObj['@_label']] = true;
    // Update all paths
    folderObj['@_path'] = config.program.folders[folderObj['@_label']].root;

    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // Create new folders
  Object.entries(config.program.folders).forEach(
    ([key, value]) => {
      if (!xmlFolderMapper[key]) {
        // create the folder
        const newId = nanoid();
        cacheObj[key] = newId;

        xmlObj.configuration.folder.push({
          '@_id': newId,
          '@_label': key,
          '@_path': value.root,
          '@_type': 'sendreceive',
          '@_rescanIntervalS': '3600',
          '@_fsWatcherEnabled': 'true',
          '@_fsWatcherDelayS': '10',
          '@_ignorePerms': 'false',
          '@_autoNormalize': 'true',
          filesystemType: 'basic',
          device: {
            '@_id': myId,
            '@_introducedBy': ''
          },
          minDiskFree: { '#text': 1, '@_unit': '%' },
          versioning: '',
          copiers: 0,
          pullerMaxPendingKiB: 0,
          hashers: 0,
          order: 'random',
          ignoreDelete: false,
          scanProgressIntervalS: 0,
          pullerPauseS: 0,
          maxConflicts: -1,
          disableSparseFiles: false,
          disableTempIndexes: false,
          paused: false,
          weakHashThresholdPct: 25,
          markerName: '.stfolder',
          copyOwnershipFromParent: false,
          modTimeWindowS: 0
        });
      }
    }
  );

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
  });
  builder.build(xmlObj);
}

export function addDevice(deviceId, directories) {
  if (deviceId.length !== 63) {
    throw new Error('Device ID Incorrect Length');
  }

  // Check if already added
  let flag1 = true;
  xmlObj.configuration.device.forEach(d => {
    if (d['@_id'] === deviceId) {
      flag1 = false;
    }
  });

  if (flag1) {
    xmlObj.configuration.device.push({
      '@_id': deviceId,
      '@_name': nanoid(),
      '@_compression': 'metadata',
      '@_introducer': 'false',
      '@_skipIntroductionRemovals': 'false',
      '@_introducedBy': '',
      address: 'dynamic',
      paused: false,
      autoAcceptFolders: false,
      maxSendKbps: 0,
      maxRecvKbps: 0,
      maxRequestKiB: 0
    });
  }

  // add device to directories
  xmlObj.configuration.folder.forEach(f => {
    let flag2 = true;
    if (directories[f['@_label']]) {
      // Modify devices
      if (typeof f.device === 'object' && !(f.device instanceof Array)) {
        f.device = [f.device];
      } else if (typeof f.device !== 'object') {
        f.device = [];
      }

      // Check if already added
      f.device.forEach(d => {
        if (d['@_id'] === deviceId) {
          flag2 = false;
        }
      });

      if (flag2) {
        f.device.push({
          '@_introducedBy': '',
          '@_id': deviceId
        });
      }
    }
  });

  saveIt();
  rebootSyncThing();
}

export function addFederatedDirectory(directoryName, directoryId, path, deviceId) {
  if (deviceId.length !== 63) {
    throw new Error('Device ID Incorrect Length');
  }

  let flag = true;
  xmlObj.configuration.folder.forEach(f => {
    if (f['@_id'] === deviceId || f['@_path'] === path) {
      flag = false;
    }
  });

  if (!flag) {
    return;
  }

  xmlObj.configuration.folder.push({
    '@_id': directoryId,
    '@_label': directoryName,
    '@_path': path,
    '@_type': 'receiveonly',
    '@_rescanIntervalS': '3600',
    '@_fsWatcherEnabled': 'true',
    '@_fsWatcherDelayS': '10',
    '@_ignorePerms': 'false',
    '@_autoNormalize': 'true',
    filesystemType: 'basic',
    device: [{
      '@_id': myId,
      '@_introducedBy': ''
    },
    {
      '@_id': deviceId,
      '@_introducedBy': ''
    }],
    minDiskFree: { '#text': 1, '@_unit': '%' },
    versioning: '',
    copiers: 0,
    pullerMaxPendingKiB: 0,
    hashers: 0,
    order: 'random',
    ignoreDelete: false,
    scanProgressIntervalS: 0,
    pullerPauseS: 0,
    maxConflicts: -1,
    disableSparseFiles: false,
    disableTempIndexes: false,
    paused: false,
    weakHashThresholdPct: 25,
    markerName: '.stfolder',
    copyOwnershipFromParent: false,
    modTimeWindowS: 0
  });

  saveIt();
  rebootSyncThing();
}

// function removeDevice(deviceId) {}

// function removeFederatedDirectory(directory) {}

function saveIt() {
  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
  });
  fs.writeFileSync(
    path.join(config.program.storage.syncConfigDirectory, 'config.xml'),
    builder.build(xmlObj),
    'utf8');
}

async function rebootSyncThing() {
  try {
    const agent = new https.Agent({
      rejectUnauthorized: false
     });

    await axios({
      method: 'post',
      url: `https://${xmlObj.configuration.gui.address}/rest/system/restart`,
      headers: { 'X-API-Key': xmlObj.configuration.gui.apikey },
      httpsAgent: agent
    });
  } catch(err) {
    winston.error('Syncthing Reboot Failed', { stack: err });
  }
}

function bootProgram() {
  if(spawnedProcess) {
    winston.warn('Sync: SyncThing already setup');
    return;
  }

  try {
    spawnedProcess = spawn(path.join(__dirname, `../../bin/syncthing/${osMap[platform]}`), ['--home', config.program.storage.syncConfigDirectory, '--no-browser'], {});

    spawnedProcess.stdout.on('data', (data) => {
      winston.info(`SYNCTHING: ${`${data}`.trim()}`);
    });

    spawnedProcess.stderr.on('data', (data) => {
      winston.info(`SYNCTHING ERROR: ${`${data}`.trim()}`);
    });

    spawnedProcess.on('close', (_code) => {
      if (preventRebootFlag === false) {
        winston.info('Syncthing failed. Attempting to reboot');
        setTimeout(() => {
          winston.info('Sync: Rebooting SyncThing');
          spawnedProcess = undefined;
          bootProgram();
        }, 4000);
      } else {
        winston.info('Syncthing Turned Off');
        preventRebootFlag = false;
      }
    });

    winston.info('Sync: SyncThing Booted');
  }catch (err) {
    winston.error(`Failed to boot SyncThing`);
    winston.error(err.message);
    return;
  }
}
