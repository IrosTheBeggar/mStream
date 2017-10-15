exports.setup = function(mstream, program){
  const child = require('child_process');
  const fe = require('path');

  // Load in API enndpoints
  // TODO: Change the name of this file
  const mstreamReadPublicDB = require('../db-read/database-public-loki.js');
  mstreamReadPublicDB.setup(mstream, program.database_plugin);

  // Var that keeps track of DB scans going on
  var userDBStatus = {};



  ///////////////////////////
  // TODO: Should we have a API call that can kill any process associated with a user and reset their scan value to false?
  ///////////////////////////

  ///////////////////////////
  // TODO: We could use some kind of manager to make sure we don't spawn to many child processes
  // For now we spawn indiscriminately and let the CPU sort it out
  ///////////////////////////


  // Handle  user status
  mstream.get('/db/status', function(req, res){
    // Get number of files in DB
    mstreamReadPublicDB.getNumberOfFiles(req.user.username, function(numOfFiles){
      var returnObject = {
        locked: false,
        totalFileCount: numOfFiles,
        dbType: 'default'
      };

      // Check if user is scanning DB
      if(userDBStatus[req.user.username] && userDBStatus[req.user.username] === true){
        returnObject.locked = true;
      }

      res.json(returnObject);
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
  mstream.get('/db/recursive-scan', function(req,res){
    var scan = scanIt(req.user, function(){});

    var statusCode = (scan.error === true) ? 555 : 200;
    res.status(statusCode).json({ status: scan.message });
  });




  function scanIt(user, callback){
    // Check that scan is not already in progress
    if(userDBStatus[user.username] == true){
      return {error:false, message: 'Scan in Progress'}; // Need to return a status
    }

    // Lock user
    userDBStatus[user.username] = true;

    // Prepare JSON load for forked process
    var jsonLoad = {
       username:user.username,
       userDir:user.musicDir,
       dbSettings: program.database_plugin,
       albumArtDir: program.albumArtDir
    }

    const forkedScan = child.fork(  fe.join(__dirname, 'database-default-manager.js'), [JSON.stringify(jsonLoad)], {silent: true});

    // TODO: Get data back from process and store it for the status API call
    forkedScan.stdout.on('data', (data) => {
      // console.log(`stdout: ${data}`);
      mstreamReadPublicDB.loadDB();
    });
    // forkedScan.stderr.on('data', (data) => {
    //   console.log(`stderr: ${data}`);
    // });
    forkedScan.on('close', (code) => {
      userDBStatus[user.username] = false;
      callback();
      console.log(`child process exited with code ${code}`);
    });

    return {error:false, message: 'Scan started'};
  }


  // Scan on startup
  function *bootScan(){
    // Loop through list of users
    for (let username in program.users) {
      if(program.users[username].guestTo){
        continue;
      }

      yield scanIt( {
        username: username,
        musicDir: program.users[username].musicDir,
      }, function(){
        mstreamReadPublicDB.loadDB();
        bootScanGenerator.next();
      });
    }
  }

  const bootScanGenerator = bootScan();
  bootScanGenerator.next();
}
