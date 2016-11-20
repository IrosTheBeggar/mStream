// TODO: This thing has to be tested

const spawn = require('child_process').spawn;
var scanLock = false;
var yetAnotherArrayOfSongs = [];
var totalFileCount = 0;

function runOnStart(){
  // Create a playlist table
  db.run("CREATE TABLE IF NOT EXISTS mstream_playlists (  id INTEGER PRIMARY KEY AUTOINCREMENT,  playlist_name varchar,  filepath varchar, hide int DEFAULT 0, user varchar, created datetime default current_timestamp);",  function() {
    // console.log('PLAYLIST TABLE CREATED');
  });
}


exports.setup = function(mstream, users, db){ // TODO
  // const scanThisDir = program.beetspath; // TODO: Check that this is a real directory
  // TODO: pull scanThisDir from the users array

  mstream.get('/db/recursive-scan', function(req,res){

    if(scanLock === true){
      // Return error
      res.status(401).send('{"error":"Scan in progress"}');
      return;
    }

    scanLock = true;
    var cmd = spawn('beet', [ 'import', '-A', '--group-albums' , scanThisDir]);

    cmd.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });

    cmd.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`);
      scanLock = false;

    });

    cmd.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
      hashFileBeets();

      // TODO: Remove all empty dirs
    });
  });


  function hashFileBeets(){
   // var hashCmd = spawn('beet check -a');
    var hashCmd = spawn('beet', [ 'check', '-a']);


    hashCmd.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });

    hashCmd.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`);
      scanLock = false;

    });

    hashCmd.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
      scanLock = false;

    });
  }

  // TODO: Function that will remove all empty folders
  function removeEmptyFolders(){
    var hashCmd = spawn('beet', [ 'check', '-a']);
    // 'find ~ -type d -empty -delete'
  }



  mstream.get('/db/status', function(req, res){
    var returnObject = {};

    returnObject.locked = scanLock;


    if(scanLock){

      // Currently we don't support filecount stats when using beets DB
      // Dummy data
      returnObject.totalFileCount = 0;
      returnObject.filesLeft = 0;


      res.json(returnObject);

    }else{
      var sql = 'SELECT Count(*) FROM items';

      db.get(sql, function(err, row){
        if(err){
          console.log(err.message);

          res.status(500).json({ error: err.message });
          return;
        }


        var fileCountDB = row['Count(*)']; // TODO: Is this correct???

        returnObject.totalFileCount = fileCountDB;
        res.json(returnObject);

      });
    }

  });


}
