const child = require('child_process');
const fe = require('path');
const mstreamReadPublicDB = require('../db-read/database-public-loki.js');
const winston = require('winston');

var bootScanGenerator;
var isScanning = false;

function scanIt(directory, vpath, program, callback) {
  var parseFlag = false;

  // Prepare JSON load for forked process
  const jsonLoad = {
    directory: directory,
    vpath: vpath,
    dbPath: fe.join(program.storage.dbDirectory, program.filesDbName),
    albumArtDirectory: program.storage.albumArtDirectory,
    skipImg: program.scanOptions.skipImg ? true : false,
    saveInterval: program.scanOptions.saveInterval ? program.scanOptions.saveInterval : 250,
    pause: program.scanOptions.pause ? program.scanOptions.pause  : false
  }

  const forkedScan = child.fork(fe.join(__dirname, 'database-default-manager.js'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started on ${jsonLoad.directory}`);
  forkedScan.stdout.on('data', (data) => {
    try {
      const parsedMsg = JSON.parse(data, 'utf8');
      winston.info(`File scan message: ${parsedMsg.msg}`);
      // TODO: Ideally, if there are no changes to the DB we should not be reloading it. Ideally...
      if(parsedMsg.loadDB === true) {
        parseFlag = true;
        mstreamReadPublicDB.loadDB();
      }
    } catch (error) {
      winston.info(`File scan message: ${data}`);
      return;
    }
  });
  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });
  forkedScan.on('close', (code) => {
    isScanning = false;
    if(parseFlag === false) {
      mstreamReadPublicDB.loadDB();
    }
    winston.info(`File scan completed with code ${code}`);
    callback();
  });
}

function* bootScan(program) {
  // Loop through folders
  for (let vpath in program.folders) {
    yield scanIt( program.folders[vpath].root, vpath, program, () => {
      bootScanGenerator.next();
    });
  }
}

function runScan(program) {
  // Check that scan is not already in progress
  if (isScanning === true) {
    return { error: true, message: 'Scan in Progress' }; // Need to return a status
  }

  isScanning = true;
  bootScanGenerator = bootScan(program);
  bootScanGenerator.next();
  return { error: false, message: 'Scan Started' };
}


exports.setup = function (mstream, program) {
  // Load in API endpoints
  mstreamReadPublicDB.setup(mstream, program);

  mstream.get('/db/status', (req, res) => {
    // Get number of files in DB
    mstreamReadPublicDB.getNumberOfFiles(req.user.vpaths, (numOfFiles) => {
      res.json({
        totalFileCount: numOfFiles,
        locked: isScanning
      });
    });
  });

  // Scan library
  mstream.get('/db/recursive-scan', (req, res) => {
    const scan = runScan(program);
    res.status((scan.error === true) ? 555 : 200).json({ status: scan.message });
  });
}

exports.runAfterBoot = function (program) {
  var scanDelay = 3;
  if (program.scanOptions && program.scanOptions.bootScanDelay && Number.isInteger(program.scanOptions.bootScanDelay) && program.scanOptions.bootScanDelay > 0) {
    scanDelay = program.scanOptions.bootScanDelay 
  }

  setTimeout(() => {
    runScan(program);
    if (program.scanOptions.scanInterval) {
      setInterval(() => runScan(program), program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, scanDelay * 1000);
}