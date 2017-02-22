//exports.setup = function(mstream, users, publicDBType, dbSettings){
exports.setup = function(mstream, program){
  const child = require('child_process');
  const fe = require('path');
  


  // Load the public DB plugin
    // sqlite3 and mysql to start, add lokiJS support latet (and maybe posgres later), maybe a NO DB option even later
  // The following api calls are all handled on a public level
  // They can be moved into a public plugin
  // pull plugin from masterDBType
  const mstreamReadPublicDB = require('../db-read/database-public-'+program.database_plugin.type+'.js');
  mstreamReadPublicDB.setup(mstream, program.database_plugin);


  var userDBStatus = {};


  mstream.get('/db/recursive-scan', function(req,res){
    // Check if user is already being scanned
    if(userDBStatus[req.user.username] == true){
      res.send('In Process. Please check status.');
      return;
    }
    //
    userDBStatus[req.user.username] = true;

    // We are using the beets in readonly mode
    if(program.database_plugin.type === 'beets' ){
      forkBeets(program.database_plugin);
      res.send('IT\'S HAPPENING! \n NOW WITH 60% MORE BEETS!');
      return;
    }

    // User is not using a private DB.
    if(!req.user.privateDB || req.user.privateDB == 'DEFAULT'){
      forkDefault(req.user, program.database_plugin);
      res.send('IT\'S HAPPENING!');
      return;
    }

    // User is using Beets as a personnal DB
    if(req.user.privateDBOptions.privateDB === 'BEETS'){
      forkBeets(req.user.privateDBOptions);
      res.send('IT\'S HAPPENING! \n NOW WITH 60% MORE BEETS!');

      // TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO:
      // TODO: Import beets DB to public DB after update is done
      return;
    }

    // YOUR CONFIG IS BAD AND YOU SHOULD FEEL BAD
    //
    userDBStatus[req.user.username] = false;
    res.send('YOUR CONFIG IS BAD AND YOU SHOULD FEEL BAD.  ABORTING!');

  });


  ///////////////////////////
  // TODO: Should we have a API call that can kill any process associated with a user and reset their scan value to false?
  ///////////////////////////

  ///////////////////////////
  // TODO: We could use some kind of manager to make sure we don't spawn to many child processes
  // For now we spawn indiscriminately and let the CPU sort it out
  ///////////////////////////

  // TODO: Test this
  function forkBeets(dbSettings){
    // Pull beets commands from config
    if((typeof dbSettings.beetsCommand === 'string' || dbSettings.beetsCommand instanceof String)){

      let beetsCommandArray = dbSettings.beetsCommand.split(" ");
      let mainCommand = beetsCommandArray.shift();

      const forkedUpdate = child.fork(mainCommand, beetsCommandArray);
      forkedScan.on('close', (code) => {
        userDBStatus[user.username] = false;
        console.log(`child process exited with code ${code}`);
      });

      // Run commands
        // beet import -A --group-albums /path/to/music
        // beet check -a
        // find ~ -type d -empty -delete
    }else{
      userDBStatus[user.username] = false;
      console.log('No command launched');
      return false;
    }


  }

  function forkDefault(user, dbSettings){
    // TODO: IMPLEMENT FORK PROPERLY
      // SEND JSON DATA TO WORKER PROCESS

    // TODO: Get data back from process and store it for the status API call

    var jsonLoad = {
       username:user.username,
       userDir:user.musicDir,
       dbSettings:dbSettings
    }

    const forkedScan = child.fork(  fe.join(__dirname, 'database-default-manager.js'), [JSON.stringify(jsonLoad)]);

    // forkedScan.stdout.on('data', (data) => {
    //   console.log(`stdout: ${data}`);
    // });
    //
    // forkedScan.stderr.on('data', (data) => {
    //   console.log(`stderr: ${data}`);
    // });

    forkedScan.on('close', (code) => {
      userDBStatus[user.username] = false;
      console.log(`child process exited with code ${code}`);
    });
  }




  // TODO: Special function that scans beets DB
  mstream.get('/db/scan-beets', function(req,res){
    // Get user info
      // Pull user's private DB config
      // Return if user is not using private DB
    // Delete users files
    // Pull all files from DB and add to publicDB
    res.send('Coming Soon');
  });

  function checkForEquality(){
    try {

    }catch(error){
      return false;
    }
  }

  // TODO: Handle  user status
  mstream.get('/db/status', function(req, res){
    // Check what system user has

    // Get number of files in DB
    mstreamReadPublicDB.getNumberOfFiles(req.user.username, function(numOfFiles){
      var returnOnject = {
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
        returnOnject.dbType = 'beets-default';
      }else if((req.user.privateDBOptions && req.user.privateDBOptions.privateDB === 'BEETS')){
        returnOnject.dbType = 'beets-default';
      }

      res.json(returnOnject);
    });


  });

  // TODO: Purge DB


  // TODO: Modify this to use the public DB
  mstream.get('/db/download-db', function(req, res){
    // Check user for beets db
    if(!req.user.privateDB || req.user.privateDB != 'BEETS'){
      res.status(500).json({ error: 'DB Error' });
      return;
    }

    // Download File
    res.download(req.user.privateDBOptions.importDB);
  });


  // Get hash of database
  mstream.get( '/db/hash', function(req, res){
    // Check if user is using beets
    if(!req.user.privateDB || req.user.privateDB != 'BEETS'){
      res.status(500).json({ error: 'DB Error' });
      return;
    }

    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');

    var fileStream = fs.createReadStream(req.user.privateDBOptions.importDB);
    fileStream.on('end', function () {
      hash.end();
      res.json( {hash:String(hash.read())} );
    });

    fileStream.pipe(hash, { end: false });
  });

}
