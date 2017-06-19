exports.setup = function(mstream, program){
  const child = require('child_process');
  const fe = require('path');

  // Load in API enndpoints
  // TODO: Change the name of this file
  const mstreamReadPublicDB = require('../db-read/database-public-sqlite.js');
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

  // TODO: Test this
  // function forkBeets(user, dbSettings, callback){
  //   var jsonLoad = {
  //      username:user.username,
  //      userDir:user.musicDir,
  //      dbSettings:dbSettings
  //   }
  //
  //   const forkedScan = child.fork(  fe.join(__dirname, 'database-beets-manager.js'), [JSON.stringify(jsonLoad)]);
  //
  //   // forkedScan.stdout.on('data', (data) => {
  //   //   console.log(`stdout: ${data}`);
  //   // });
  //   // forkedScan.stderr.on('data', (data) => {
  //   //   console.log(`stderr: ${data}`);
  //   // });
  //   forkedScan.on('close', (code) => {
  //     userDBStatus[user.username] = false;
  //     callback();
  //     console.log(`child process exited with code ${code}`);
  //   });
  // }

  function forkDefault(user, dbSettings, callback){
    // TODO: Get data back from process and store it for the status API call
    var jsonLoad = {
       username:user.username,
       userDir:user.musicDir,
       dbSettings:dbSettings,
       albumArtDir: program.albumArtDir
    }

    const forkedScan = child.fork(  fe.join(__dirname, 'database-default-manager.js'), [JSON.stringify(jsonLoad)]);

    // forkedScan.stdout.on('data', (data) => {
    //   console.log(`stdout: ${data}`);
    // });
    // forkedScan.stderr.on('data', (data) => {
    //   console.log(`stderr: ${data}`);
    // });
    forkedScan.on('close', (code) => {
      userDBStatus[user.username] = false;
      callback();
      console.log(`child process exited with code ${code}`);
    });
  }



  // function updateBeets(){
  //   // Pull beets commands from config
  //   if((typeof dbSettings.beetsCommand === 'string' || dbSettings.beetsCommand instanceof String)){
  //
  //     let beetsCommandArray = dbSettings.beetsCommand.split(" ");
  //     let mainCommand = beetsCommandArray.shift();
  //
  //     const forkedUpdate = child.fork(mainCommand, beetsCommandArray);
  //     forkedScan.on('close', (code) => {
  //       userDBStatus[user.username] = false;
  //       console.log(`child process exited with code ${code}`);
  //     });
  //
  //     // Run commands
  //       // beet import -A --group-albums /path/to/music
  //       // beet check -a
  //       // find ~ -type d -empty -delete
  //   }else{
  //     userDBStatus[user.username] = false;
  //     console.log('No command launched');
  //     return false;
  //   }
  // }



  // TODO: Special function that scans beets DB
  // mstream.get('/db/scan-beets', function(req,res){
  //   // updateBeets();
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });


  // Handle  user status
  mstream.get('/db/status', function(req, res){
    // Check what system user has

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

      // Check for beets
      if(program.database_plugin.type === 'beets' ){
        returnObject.dbType = 'beets';
      }else if((req.user.privateDBOptions && req.user.privateDBOptions.privateDB === 'BEETS')){
        returnObject.dbType = 'beets';
      }

      res.json(returnObject);
    });


  });


  // TODO: Is this still necessary???
  // mstream.get('/db/download-db', function(req, res){
  //   // Check user for beets db
  //   if(!req.user.privateDB || req.user.privateDB != 'BEETS'){
  //     res.status(500).json({ error: 'DB Error' });
  //     return;
  //   }
  //
  //   // Download File
  //   res.download(req.user.privateDBOptions.importDB);
  // });
  //
  //
  // // Get hash of database
  // mstream.get( '/db/hash', function(req, res){
  //   // Check if user is using beets
  //   if(!req.user.privateDB || req.user.privateDB != 'BEETS'){
  //     res.status(500).json({ error: 'DB Error' });
  //     return;
  //   }
  //
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








  // TODO: Clean this up
  mstream.get('/db/recursive-scan', function(req,res){
    var scan = scanIt(req.user, function(){});

    var statusCode = (scan.error === true) ? 555 : 200;
    res.status(statusCode).json({ status: scan.message });
  });




  function scanIt(user, callback){
    if(userDBStatus[user.username] == true){
      console.log('Scan In Progress')
      return {error:false, message: 'Scan in Progress'}; // Need to return a status
    }

    // Lock user
    userDBStatus[user.username] = true;

    // User is using mStream's built in DB and metadata tools
    if(!user.privateDB || user.privateDB == 'DEFAULT'){
      forkDefault(user, program.database_plugin, callback);
      return {error:false, message: 'Scan started'};
    }

    // User is using Beets as a personnal DB
    // if(user.privateDBOptions.privateDB === 'BEETS'){
    //   forkBeets(user.privateDBOptions,  callback);
    //   return {error:false, message: 'Import of Beets DB started'};
    // }

    userDBStatus[user.username] = false;
    return {error:true, message: 'YOUR CONFIG IS BAD AND YOU SHOULD FEEL BAD. ABORTING!'};
  }


  // TODO: Make this queue run several in parallel
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
        // TODO: Add generator and yield here
        bootScanGenerator.next();
      });
    }
  }

  const bootScanGenerator = bootScan();
  bootScanGenerator.next();

}
