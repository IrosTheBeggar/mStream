const os = require('os');
const fs = require('fs');
const nanoid = require('nanoid')
const winston = require('winston');
const path = require('path');
const { spawn } = require('child_process');
const parser = require('fast-xml-parser');
const axios = require('axios');
const https = require('https');

var spawnedProcess;
const platform = os.platform();
const osMap = {
  "win32": "syncthing.exe",
  "darwin": "syncthing-osx",
  "linux": "syncthing-linux",
  "android": "syncthing-android"
};

let myId;
const cacheObj = {};
let syncConfigPath;
let xmlObj;

let syncApiAddress;
let syncApiKey;

exports.getXml = function() {
  return xmlObj;
}

exports.getId = function() {
  return myId;
}

exports.getPathId = function(path) {
  return cacheObj[path];
}

exports.setup = function (program) {
  syncConfigPath = program.storage.syncConfigDirectory;

  program.killThese.push(
    () => {
      // kill all workers
      if(spawnedProcess) {
        spawnedProcess.stdin.pause();
        spawnedProcess.kill();
      }  
    }
  );

  setupNew(program);
}

function setupNew(program) {
  const newProcess = spawn(path.join(__dirname, `../sync/${osMap[platform]}`), [`--generate=${program.storage.syncConfigDirectory}`], {});

  newProcess.stdout.on('data', (data) => {
    winston.info(`sync: ${data}`);
  });

  newProcess.stderr.on('data', (data) => {
    winston.info(`sync err: ${data}`);
  });

  newProcess.on('close', (code) => {
    if (code !== 0) {
      winston.error('SyncThing: Failed to setup new directory');
      return;
    }
    getId(program)
  });
}

function getId(program) {
  const newProcess = spawn(path.join(__dirname, `../sync/${osMap[platform]}`), ['--home', program.storage.syncConfigDirectory, `--device-id`], {});

  newProcess.stdout.on('data', (data) => {
    myId = `${data}`.trim();
  });

  newProcess.stderr.on('data', (data) => {
    winston.info(`sync err: ${data}`);
  });

  newProcess.on('close', (code) => {
    if (code !== 0) {
      winston.error('SyncThing: Failed to setup new directory');
      return;
    }
    console.log(myId);
    modifyConfig(program)
  });
}

function modifyConfig(program) {     
  xmlObj = parser.parse(fs.readFileSync(path.join(program.storage.syncConfigDirectory, 'config.xml'), 'utf8'), {ignoreAttributes : false});
  console.log(xmlObj)

  // disable gui
  xmlObj.configuration.gui['@_enabled'] = 'true';
  
  syncApiAddress = xmlObj.configuration.gui.address;
  syncApiKey =  xmlObj.configuration.gui.apikey;

  // modify folders
  if (typeof xmlObj.configuration.folder === 'object' && !(xmlObj.configuration.folder instanceof Array)) {
    xmlObj.configuration.folder = [xmlObj.configuration.folder];
  } else if (typeof xmlObj.configuration.folder !== 'object') {
    xmlObj.configuration.folder = [];
  }

  // modify devices
  if (typeof xmlObj.configuration.device === 'object' && !(xmlObj.configuration.device instanceof Array)) {
    xmlObj.configuration.device = [xmlObj.configuration.device];
  } else if (typeof xmlObj.configuration.device !== 'object') {
    xmlObj.configuration.device = [];
  }

  // Remove old folders
  xmlObj.configuration.folder = xmlObj.configuration.folder.filter(folder => {
    return !!program.folders[folder['@_label']]
  });

  const xmlFolderMapper = {};
  xmlObj.configuration.folder.forEach(folderObj => {
    xmlFolderMapper[folderObj['@_label']] = true;
    // Update all paths
    folderObj['@_path'] = program.folders[folderObj['@_label']].root;

    cacheObj[folderObj['@_label']] = folderObj['@_id'];
  });

  // Create new folders
  Object.entries(program.folders).forEach(
    ([key, value]) => {
      console.log(key, value);
      if (!xmlFolderMapper[key]) {
        console.log('CREATE')
        // create the folder
        const newId = nanoid();
        cacheObj[key] = newId;

        xmlObj.configuration.folder.push({
          '@_id': newId,
          '@_label': key,
          '@_path': value.root,
          '@_type': 'sendonly',
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

  console.log(xmlObj.configuration);

  const final = (new (require("fast-xml-parser").j2xParser)({
    format:true,
    ignoreAttributes : false,
  })).parse(xmlObj);

  console.log(final);
  saveIt();
  bootProgram(program);
}

exports.addDevice =  function(deviceId, directories) {
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

exports.addFederatedDirectory = function(directoryName, directoryId, path, deviceId) {
  if (deviceId.length !== 63) {
    throw new Error('Device ID Incorrect Length');
  }

  let flag = true;
  xmlObj.configuration.folder.forEach(f => {
    if (f['@_id'] === deviceId || f['@_path'] === path) {
      flag1 = false;
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

function removeDevice(deviceId) {}

function removeFederatedDirectory(directory) {}

function saveIt() {
  fs.writeFileSync(
    path.join(syncConfigPath, 'config.xml'), 
    (new (require("fast-xml-parser").j2xParser)({
      format:true,
      ignoreAttributes : false,
    })).parse(xmlObj), 
    'utf8');
}

async function rebootSyncThing() {
  const agent = new https.Agent({  
    rejectUnauthorized: false
   });

  try {
    console.log(syncApiAddress + '/rest/system/config')
    await axios({
      method: 'post',
      url: 'https://' + syncApiAddress + '/rest/system/restart', 
      headers: { 'X-API-Key': syncApiKey },
      httpsAgent: agent
    });
  } catch(err) {
    console.log(err)
  }
}

function bootProgram(program) {
  if(spawnedProcess) {
    winston.warn('Sync: SyncThing already setup');
    return;
  }

  try {
    spawnedProcess = spawn(path.join(__dirname, `../sync/${osMap[platform]}`), ['--home', program.storage.syncConfigDirectory, '--no-browser'], {});

    spawnedProcess.stdout.on('data', (data) => {
      winston.info(`sync: ${data}`);
    });

    spawnedProcess.stderr.on('data', (data) => {
      winston.info(`sync err: ${data}`);
    });

    spawnedProcess.on('close', (code) => {
      winston.info('Sync: SyncThing failed. Attempting to reboot');
      setTimeout(() => {
        winston.info('Sync: Rebooting SyncThing');
        delete spawnedProcess;
        bootProgram(program);
      }, 4000);
    });

    winston.info('Sync: SyncThing Booted');
  }catch (err) {
    winston.error(`Failed to boot SyncThing`);
    winston.error(err.message);
    return;
  }
}