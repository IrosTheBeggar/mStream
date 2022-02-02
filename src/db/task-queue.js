const child = require('child_process');
const path = require('path');
const winston = require('winston');
const nanoid = require('nanoid');
const jwt = require('jsonwebtoken');
const config = require('../state/config');

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
let scanIntervalTimer = null; // This gets set after the server boots

function addScanTask(vpath) {
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid.nanoid(8) };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

function scanAll() {
  Object.keys(config.program.folders).forEach((vpath) => {
    addScanTask(vpath);
  });
}

function nextTask() {
  if (
    taskQueue.length > 0
    && runningTasks.size < config.program.scanOptions.maxConcurrentTasks
    && !vpathLimiter.has(taskQueue[taskQueue.length - 1].vpath))
  {
    runScan(taskQueue.pop());
  }
}

function runScan(scanObj) {
  const jsonLoad = {
    directory: config.program.folders[scanObj.vpath].root,
    vpath: scanObj.vpath,
    port: config.program.port,
    token: jwt.sign({ scan: true }, config.program.secret),
    albumArtDirectory: config.program.storage.albumArtDirectory,
    skipImg: config.program.scanOptions.skipImg,
    pause: config.program.scanOptions.pause,
    supportedFiles: config.program.supportedAudioFiles,
    scanId: scanObj.id,
    isHttps: config.getIsHttps(),
    compressImage: config.program.scanOptions.compressImage
  };

  const forkedScan = child.fork(path.join(__dirname, './scanner.js'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started on ${jsonLoad.directory}`);
  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  forkedScan.stdout.on('data', (data) => {
    winston.info(`File scan message: ${data}`);
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`File scan completed with code ${code}`);
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(scanObj.vpath);
    nextTask();
  });
}

exports.scanVPath = (vPath) => {
  addScanTask(vPath);
}

exports.scanAll = () => {
  scanAll();
}

exports.isScanning = () => {
  return runningTasks.size > 0 ? true : false;
}

exports.getAdminStats = () => {
  return {
    taskQueue,
    vpaths: [...vpathLimiter]
  };
}

exports.runAfterBoot = () => {
  setTimeout(() => {
    // This only gets run once after boot. Will not be run on server restart b/c scanIntervalTimer is already set
    if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanAll();
      scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

exports.resetScanInterval = () => {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}