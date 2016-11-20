exports.setup = function(mstream, users, publicDBType){
  // Go through all vars and determine plugins needed
  var privateDB = false;
  for (i = 0; i < program.users.length; i++) {
    // Check for beets
    // privateDB = sqlite3;
  }
    // sqlite3, mysql, sequelize, lokiJS, (? posgres)
      // This will allow us to make sqlite3 an optional dependancy once lokiJS works
    // Make sure all users have uniform settings for the inital run, we'll handle mixed settings later





    // Load the public DB plugin
      // sqlite3 and mysql to start, add lokiJS support latet (and maybe posgres later), maybe a NO DB option even later
// The following api calls are all handled on a public level
// They can be moved into a public plugin
// pull plugin from masterDBType
const mstreamPublicDB = require('./modules/database-public-'+publicDBType+'.js');
mstreamPublicDB.setup(mstream);





// TODO: Load any plugins necessary for habdling indivudal user dbs
  // Then construct routing between api calls and userDB management functions

  // TODO: Handle DB write functions
  mstream.get('/db/status', function(req, res){
  });
  mstream.get('/db/recursive-scan', function(req,res){
  });

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
