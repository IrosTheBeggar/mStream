const child = require('child_process');
const path = require('path');
const winston = require('winston');
const nanoid = require('nanoid');
const globals = require('../global');
const mstreamReadPublicDB = require('../../modules/db-read/database-public-loki');

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();

function addScanTask(vpath) {
  if (runningTasks.size < globals.program.scanOptions.maxConcurrentTasks) {
    runScan(vpath);
  } else {
    taskQueue.push({ task: 'scan', vpath: vpath, id: nanoid.nanoid(8) });
  }
}

function removeTask(taskId) {

}

function scanAll() {
  Object.keys(globals.program.folders).forEach((vpath) => {
    addScanTask(vpath);
  });
}

function nextTask() {
  if (taskQueue.length > 0 && runningTasks.size < globals.program.scanOptions.maxConcurrentTasks && !vpathLimiter.has(taskQueue[taskQueue.length - 1].vpath)) {
    runScan(taskQueue.pop().vpath);
  }
}

function runScan(vpath) {
  let parseFlag = false;

  const jsonLoad = {
    directory: globals.program.folders[vpath].root,
    vpath: vpath,
    dbPath: path.join(globals.program.storage.dbDirectory, globals.program.filesDbName),
    albumArtDirectory: globals.program.storage.albumArtDirectory,
    skipImg: globals.program.scanOptions.skipImg ? true : false,
    saveInterval: globals.program.scanOptions.saveInterval ? globals.program.scanOptions.saveInterval : 250,
    pause: globals.program.scanOptions.pause ? globals.program.scanOptions.pause : false
  };

  const forkedScan = child.fork(path.join(__dirname, '../../modules/db-management/database-default-manager.js'), [JSON.stringify(jsonLoad)], { silent: true });
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

exports.runAfterBoot = () => {
  setTimeout(() => {
    scanAll();
    if (globals.program.scanOptions.scanInterval > 0) {
      setInterval(() => runScan(), globals.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, globals.program.scanOptions.scanDelay * 1000);
}