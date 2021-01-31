const child = require('child_process');
const path = require('path');
const winston = require('winston');
const nanoid = require('nanoid');
const config = require('../state/config');
const mstreamReadPublicDB = require('../../modules/db-read/database-public-loki');

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
let scanIntervalTimer = null; // This gets set after the server boots

function addScanTask(vpath) {
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(vpath);
  } else {
    taskQueue.push({ task: 'scan', vpath: vpath, id: nanoid.nanoid(8) });
  }
}

function removeTask(taskId) {

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
    runScan(taskQueue.pop().vpath);
  }
}

function runScan(vpath) {
  let parseFlag = false;

  const jsonLoad = {
    directory: config.program.folders[vpath].root,
    vpath: vpath,
    dbPath: path.join(config.program.storage.dbDirectory, mstreamReadPublicDB.getFileDbName()),
    albumArtDirectory: config.program.storage.albumArtDirectory,
    skipImg: config.program.scanOptions.skipImg,
    saveInterval: config.program.scanOptions.saveInterval,
    pause: config.program.scanOptions.pause,
    supportedFiles: config.program.supportedAudioFiles
  };

  const forkedScan = child.fork(path.join(__dirname, './scanner.js'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started on ${jsonLoad.directory}`);
  runningTasks.add(forkedScan);
  vpathLimiter.add(vpath);

  forkedScan.stdout.on('data', (data) => {
    try {
      const parsedMsg = JSON.parse(data, 'utf8');
      winston.info(`File scan message: ${parsedMsg.msg}`);
      // TODO: Ideally, if there are no changes to the DB we should not be reloading it. Ideally...
      if (parsedMsg.loadDB === true) {
        parseFlag = true;
        mstreamReadPublicDB.loadDB();
      }
    } catch (error) {
      winston.info(`File scan message: ${data}`);
    }
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    if(parseFlag === false) {
      mstreamReadPublicDB.loadDB();
    }
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(vpath);
    nextTask();
    winston.info(`File scan completed with code ${code}`);
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
  console.log(taskQueue);
  console.log(vpathLimiter);
  console.log(runningTasks);

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
  }, config.program.scanOptions.scanDelay * 1000);
}

exports.resetScanInterval = () => {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}