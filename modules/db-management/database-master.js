const child = require('child_process');
const fe = require('path');
const mstreamReadPublicDB = require('../db-read/database-public-loki.js');

exports.setup = function (mstream, program) {
  // Load in API endpoints
  mstreamReadPublicDB.setup(mstream, program);

  // Var that keeps track of DB scans going on
  var isScanning = false;

  // Get db status
  mstream.get('/db/status', function (req, res) {
    // Get number of files in DB
    mstreamReadPublicDB.getNumberOfFiles(req.user.vpaths, function (numOfFiles) {
      res.json({
        totalFileCount: numOfFiles,
        dbType: 'default',
        locked: isScanning
      });
    });
  });


  // TODO: Is this still necessary???
  // mstream.get('/db/download-db', function(req, res){
  //   // Download File
  //   res.download(req.user.privateDBOptions.importDB);
  // });
  // // Get hash of database
  // mstream.get( '/db/hash', function(req, res){
  //   var hash = crypto.createHash('sha256');
  //   hash.setEncoding('hex');
  //
  //   var fileStream = fs.createReadStream(req.user.privateDBOptions.importDB);
  //   fileStream.on('end', function () {
  //     hash.end();
  //     res.json( {hash:String(hash.read())} );
  //   });
  //
  //   fileStream.pipe(hash, { end: false });
  // });



  // Scan library
  mstream.get('/db/recursive-scan', function (req, res) {
    var scan = runScan();
    res.status((scan.error === true) ? 555 : 200).json({ status: scan.message });
  });


  function scanIt(directory, vpath, callback) {
    var parseFlag = false;

    // Prepare JSON load for forked process
    var jsonLoad = {
      directory: directory,
      vpath: vpath,
      dbSettings: program.database_plugin,
      albumArtDir: program.albumArtDir,
      skipImg: program.database_plugin.skipImg ? true : false,
      saveInterval: program.database_plugin.saveInterval ? program.saveInterval : 250
    }

    const forkedScan = child.fork(fe.join(__dirname, 'database-default-manager.js'), [JSON.stringify(jsonLoad)], { silent: true });

    forkedScan.stdout.on('data', (data) => {
      try {
        var json = JSON.parse(data, 'utf8');
        console.log(`stdout: ${json.msg}`);
      } catch (error) {
        console.log(`stdout: ${data}`);
      }

      // TODO: Ideally, if there are no changes to the DB we should not be reloading it. Ideally...
      if(json.loadDB === true) {
        parseFlag = true;
        console.log(parseFlag)
        mstreamReadPublicDB.loadDB();
      }
    });
    forkedScan.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`);
    });
    forkedScan.on('close', (code) => {
      isScanning = false;
      if(parseFlag === false) {
        mstreamReadPublicDB.loadDB();
      }
      callback();
      console.log(`file scan completed with code ${code}`);
    });
  }


  // Scan on startup
  function* bootScan() {
    // Loop through list of users
    for (let vpath in program.folders) {

      yield scanIt( program.folders[vpath].root, vpath, () => {
        bootScanGenerator.next();
      });
    }
  }


  var bootScanGenerator;
  function runScan() {
    // Check that scan is not already in progress
    if (isScanning === true) {
      return { error: true, message: 'Scan in Progress' }; // Need to return a status
    }

    // Lock user
    isScanning = true;

    bootScanGenerator = bootScan();
    bootScanGenerator.next();

    return { error: false, message: 'Scan Started' };
  }

  runScan();

  if (program.database_plugin.interval) {
    setInterval(() => runScan(), program.database_plugin.interval * 60 * 60 * 1000);
  }
}
