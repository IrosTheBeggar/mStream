import os from 'os';
import fs from 'fs';
import { nanoid } from 'nanoid';
import winston from 'winston';
import path from 'path';
import { spawn } from 'child_process';
import kill from 'tree-kill';
import * as killQueue from './kill-list.js';
import * as config from './config.js';
import * as db from '../db/manager.js';
import { appRoot } from '../util/esm-helpers.js';

const platform = os.platform();
const osMap = {
  "win32": "syncthing.exe",
  "darwin": "syncthing-osx",
  "linux": "syncthing-linux",
  "android": "syncthing-android"
};

// Resolve the syncthing binary, restoring +x on unix before use: the committed
// binaries can be mode 0644 in git, and tar / npm-pack / Docker can strip the
// execute bit, which makes spawn() fail with EACCES. (rust-parser and
// rust-server-audio self-heal the same way before they spawn.)
function syncthingBin() {
  const p = path.join(appRoot, `bin/syncthing/${osMap[platform]}`);
  if (platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch (_) { /* best-effort */ } }
  return p;
}

let spawnedProcess;

let xmlObj; // Syncthing XML Config
let myId; // Syncthing Device ID
const cacheObj = {};

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
  // FEDERATION UNWIRED: uiAddress was populated by loadConfig, which was removed
  // along with the fast-xml-parser dependency. It is never set while federation
  // is parked, so this always throws (no live caller — see src/server.js).
  throw new Error('Syncthing UI Address Not Set');
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
    const newProcess = spawn(syncthingBin(), [`--generate=${config.program.storage.syncConfigDirectory}`], {});

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
    const newProcess = spawn(syncthingBin(), ['--home', config.program.storage.syncConfigDirectory, `--device-id`], {});

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
  // FEDERATION UNWIRED: parsed config.xml via fast-xml-parser, which has been
  // removed from the dependency tree. Re-add an XML parser here (and the
  // builder in saveIt) when federation/syncthing is revived (see src/server.js).
}

function removeFoldersFromConfig() {
  // Removes all folders
  xmlObj.configuration.folder = xmlObj.configuration.folder.filter(folder => {
    return !!db.getLibraryByName(folder['@_label'])
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
    const lib = db.getLibraryByName(folderObj['@_label']);
    if (lib) { folderObj['@_path'] = lib.root_path; }

    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // Create new folders
  db.getAllLibraries().forEach(
    (lib) => {
      const key = lib.name;
      const value = { root: lib.root_path };
      if (!xmlFolderMapper[key]) {
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
  // FEDERATION UNWIRED: serialised xmlObj back to config.xml via fast-xml-parser's
  // XMLBuilder, which has been removed. Re-add an XML builder here (and the
  // parser in loadConfig) when federation/syncthing is revived.
}

// Syncthing's local REST API serves HTTPS with a self-signed cert that Node's
// global fetch rejects; this reboot previously bypassed that with an undici
// Agent dispatcher ({ connect: { rejectUnauthorized: false } }). `undici` was
// the only thing in the dependency tree that used it, so the dependency was
// removed and this call is stubbed while federation/syncthing is unwired (see
// src/server.js). On revival, re-add a TLS-bypass mechanism (an undici Agent
// dispatcher or a node:https request) for the POST to /rest/system/restart.
function rebootSyncThing() {
  winston.warn('Syncthing reboot skipped — federation is unwired (undici removed)');
}

function bootProgram() {
  if(spawnedProcess) {
    winston.warn('Sync: SyncThing already setup');
    return;
  }

  try {
    spawnedProcess = spawn(syncthingBin(), ['--home', config.program.storage.syncConfigDirectory, '--no-browser'], {});

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
