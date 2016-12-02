//exports.setup = function(mstream, users, publicDBType, dbSettings){
exports.setup = function(mstream, program){
  const child = require('child_process');


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

    // Get user's db setup
    if(!req.user.privateDB || req.user.privateDB == 'DEFAULT'){
      forkDefault(req.user, program.database_plugin);
      res.send('IT\'S HAPPENING!');
      return;
    }

    if(req.user.privateDB == 'BEETS'){
      forkBeets(req.user);
      res.send('IT\'S HAPPENING! \n NOW WITH 60% MORE BEETS!');
      return;
    }

    // YOUR CONFIG IS BAD AND YOU SHOULD FEEL BAD
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

  // TODO: Fill this out
  function forkBeets(user, publicDBType, dbSettings){
    // Pull beets commands from config

    // Run commands
      // beet import -A --group-albums /path/to/music
      // beet check -a
      // find ~ -type d -empty -delete
  }

  function forkDefault(user, dbSettings){
    // TODO: IMPLEMENT FORK PROPERLY
      // SEND JSON DATA TO WORKER PROCESS
    var jsonLoad = {
       username:user.username,
       userDir:user.musicDir,
       dbSettings:dbSettings
    }

    const forkedScan = child.fork(__dirname + '/database-default-manager.js', [JSON.stringify(jsonLoad)]);

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


  // TODO: Special function that just transfers fiels from users private DB to public DB
  mstream.get('/db/import-DB', function(req,res){
    // Get user info
      // Pull user's private DB config
      // Return if user is not using private DB
    // Delete users files
    // Pull all files from DB and add to publicDB
  });


  // TODO: Handle  user status
  mstream.get('/db/status-mstream', function(req, res){
    res.send('Coming Soon!');
  });

}
