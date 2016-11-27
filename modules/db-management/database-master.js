const spawn = require('child_process').spawn;

exports.setup = function(mstream, users, publicDBType){

    // sqlite3, mysql, sequelize, lokiJS, (? posgres)
      // This will allow us to make sqlite3 an optional dependancy once lokiJS works
    // Make sure all users have uniform settings for the inital run, we'll handle mixed settings later





      // Load the public DB plugin
        // sqlite3 and mysql to start, add lokiJS support latet (and maybe posgres later), maybe a NO DB option even later
  // The following api calls are all handled on a public level
  // They can be moved into a public plugin
  // pull plugin from masterDBType
  const mstreamReadPublicDB = require('./modules/db-read/database-public-'+publicDBType+'.js');
  mstreamReadPublicDB.setup(mstream);



  mstream.get('/db/recursive-scan', function(req,res){
    // Get user's db setup

    // spawn a child_process to scan
    // spawnBeets(user, userCommand);  // For beets we need pull the exact command to launch from the user config
    // spawnDefault(user);
  });

  function spawnDefault(user){

  }


  // TODO: Handle  user status
  mstream.get('/db/status-mstream', function(req, res){
  });


// ========================================================================================
// // Either copy from sqliteDB or use built-in functions
// // Go through all vars and determine plugins needed
// var useMstream = false;
// var useBeets = false;
//
// for (i = 0; i < program.users.length; i++) {
//   // Check for beets
//   // var useMstream = true;
//   // var useBeets = true;
// }
// if(useMstream){
//   const mstreamWritePublicDB = require('./modules/database-default-'+publicDBType+'.js'); // FIXME; Rename
//   mstreamWritePublicDB.setup(mstream, users, db);
// }
// if(useBeets){
//   const beetsWritePublicDB = require('./modules/database-beets-'+publicDBType+'.js'); // FIXME; Rename
// }
// ========================================================================================








// TODO: Load any plugins necessary for habdling indivudal user dbs
  // Then construct routing between api calls and userDB management functions


  // TODO: Handle Specialized DB Functions
  // mstream.get('/db/download-db', function(req, res){
  // });
  // mstream.get( '/db/hash', function(req, res){
  // });

}



// Case 1: totalally managed by mstream, sqlite3 for everything

// Case 2: beets DB for every user, mysql for public DB

// Case 3: totally managed by mstream, lokiJS for everything

// Next step: mixed user settings
// Next step: backup as local DB and import from backup
