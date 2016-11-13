#!/usr/bin/env node
"use strict";

const express = require('express');
const mstream = express();
const fs = require('graceful-fs');  // File System
const fe = require('path');
const bodyParser = require('body-parser');
var program = require('commander');  // Command Line Parser
const archiver = require('archiver');  // Zip Compression
const os = require('os');
const crypto = require('crypto');
const slash = require('slash');
const sqlite3 = require('sqlite3').verbose();


// Setup Command Line Interface
program
  .version('1.21.0')
  .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
  .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
  .option('-g, --gateip <gateip>', 'Manually set gateway IP for the tunnel option')
  .option('-l, --login', 'Require users to login')
  .option('-u, --user <user>', 'Set Username')
  .option('-x, --password <password>', 'Set Password')
  .option('-G, --guest <guestname>', 'Set Guest Username')
  .option('-X, --guestpassword <guestpassword>', 'Set Guest Password')
  // .option('-k, --key <key>', 'Add SSL Key')
  // .option('-c, --cert <cert>', 'Add SSL Certificate')
  .option('-d, --database <path>', 'Specify Database Filepath', 'mstreamdb.lite')
  .option('-b, --beetspath <folder>', 'Specify Folder where Beets DB should import music from.  This also overides the normal DB functions with functions that integrate with beets DB')
  .option('-i, --userinterface <folder>', 'Specify folder name that will be served as the UI', 'public')
  .option('-f, --filepath <folder>', 'Set the path of your music directory', process.cwd())
  .option('-s, --secret <secret>', 'Set the login secret key')
  .parse(process.argv);


// TODO: Cleanup global vars
// For DB
const db = new sqlite3.Database(program.database);
var scanLock = false;
var yetAnotherArrayOfSongs = [];
var totalFileCount = 0;

// If we are not using Beets DB, we need to prep the DB
if(!program.beetspath){
  db.run("CREATE TABLE IF NOT EXISTS items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
    // console.log('TABLES CREATED');
  });
}
// Create a playlist table
db.run("CREATE TABLE IF NOT EXISTS mstream_playlists (  id INTEGER PRIMARY KEY AUTOINCREMENT,  playlist_name varchar,  filepath varchar, hide int DEFAULT 0, created datetime default current_timestamp);",  function() {
  // console.log('PLAYLIST TABLE CREATED');
});




// Normalize for all OS
// Make sure it's a directory
if(!fs.statSync( program.filepath ).isDirectory()){
  console.log('GIVEN DIRECTORY DOES NOT APPEAR TO BE REAL');
  process.exit();
}

const rootDir = fe.normalize(program.filepath);

// Normalize It
if(!fe.isAbsolute(program.filepath) ){
  rootDir = fe.join(process.cwd,   rootDir);
}


const userinterface = program.userinterface;
// Check that this is a real dir
if(!fs.statSync( fe.join(__dirname, userinterface) ).isDirectory()){
  console.log('The userinterface was not found.  Closing...');
  process.exit();
}

// Static files
mstream.use( express.static(fe.join(__dirname, userinterface) ));
mstream.use( '/'  , express.static( rootDir  ));

// Magic Middleware Things
mstream.use(bodyParser.json()); // support json encoded bodies
mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies


// Handle ports. Default is 3000
const port = program.port;
console.log('Access mStream locally: http://localhost:' + port);



// Auto tunnel to the external world
if(program.tunnel){
  var tunnelLibrary;
  var client;

  function tunnel_uPNP(){
    try{
      console.log('Preparing to tunnel via upnp protocol');

      tunnelLibrary = require('nat-upnp');
      client = tunnelLibrary.createClient();

      client.portMapping({
        public: port,
        private: port,
        ttl: 10
      }, function(err) {
        // Will be called once finished
        if (err) {
          // every service in the list has failed
          throw err;
        }
      });

      var getIP = require('external-ip')();

      getIP(function (err, ip) {
        if (err) {
          // every service in the list has failed
          throw err;
        }
        console.log('Access mStream on the internet: http://' + ip + ':' + port);
      });


    }
    catch (e) {
      console.log('WARNING: mStream uPNP tunnel functionality has failed.  Your network may not allow this functionality');
      console.log(e);

      // Try a backup method
      tunnel_NAT_PMP();
    }
  }

  function tunnel_NAT_PMP(){
    try{
      console.log('Preparing to tunnel via nat-pmp protocol');


      tunnelLibrary = require('nat-pmp');

      // Use the user supplied Gateway IP or try to find it manually
      if(program.gateway){
        var gateway = program.gateway;
      }else{
        var netroute = require('netroute');
        var gateway = netroute.getGateway();
      }

      console.log('Attempting to tunnel via gateway: ' + gateway);

      client = new tunnelLibrary.Client(gateway);
      client.portMapping({ public: port, private: port }, function (err, info) {
        if (err) {
          throw err;
        }
        client.close();
      });

      var getIP = require('external-ip')();

      getIP(function (err, ip) {
        if (err) {
          // every service in the list has failed
          throw err;
        }
        console.log('Access mStream on the internet: http://' + ip + ':' + port);
      });
    }
    catch (e) {
      console.log('WARNING: mStream nat-pmp tunnel functionality has failed.  Your network may not allow functionality');
      console.log(e);
    }
  }

  tunnel_uPNP();
}


// Print the local network IP
console.log('Access mStream on your local network: http://' + require('my-local-ip')() + ':' + port);



// Serve the webapp
mstream.get('/', function (req, res) {
	res.sendFile(  fe.join(userinterface, 'mstream.html'), { root: __dirname });
});


// Login functionality
if(program.login){
  if(!program.password || !program.user){
    console.log('User credentials are missing.  Please make sure to supply both a username and password via the -u and -p commands respectivly.  Aborting');
    process.exit(1);
  }

  // Use bcrypt for password storage
  const bcrypt = require('bcrypt');
  const jwt = require('jsonwebtoken'); // used to create, sign, and verify tokens

  var secret;
  var secretIsFile = false;

  // Check for filepath
  try{
    if(fs.statSync(program.secret).isFile()){
      secretIsFile = true;
    }
  }catch(error){}


  if(secretIsFile === true){
    secret = fs.readFileSync(program.secret, 'utf8')
  }else if(program.secret){
    secret = String(program.secret);
  }else{
    require('crypto').randomBytes(48, function(err, buffer) {
      secret = buffer.toString('hex');
    });
  }

  // Create the user array
  var Users = {};

  Users[program.user] = {
    'guest': false,
    'password':'',
  }

  // Encrypt the password
  bcrypt.genSalt(10, function(err, salt) {
    bcrypt.hash(program.password, salt, function(err, hash) {
      // Store hash in your password DB.
      Users[program.user]['password'] = hash;
    });
  });

  // Handle guest account
  if(program.guest && program.guestpassword){
    Users[program.guest] = {
      'guest': true,
      'password':'',
    }

    // Encrypt the password
    bcrypt.genSalt(10, function(err, salt) {
      bcrypt.hash(program.guestpassword, salt, function(err, hash) {
        // Store hash in your password DB.
        Users[program.guest]['password'] = hash;
      });
    });
  }

  // Failed Login Attempt
  mstream.get('/login-failed', function (req, res) {
    // Wait before sending the response
    setTimeout((function() {
      res.status(599).send(JSON.stringify({'Error':'Try Again'}))
    }), 800);
  });

  mstream.get('/access-denied', function (req, res) {
    res.status(598).send(JSON.stringify({'Error':'Access Denied'}));
  });

  mstream.get('/guest-access-denied', function (req, res) {
    res.status(597).send(JSON.stringify({'Error':'Access Denied'}));
  });

  // route to authenticate a user (POST http://localhost:8080/api/authenticate)
  mstream.post('/login', function(req, res) {
    let username = req.body.username;
    let password = req.body.password;

    // Check is user is in array
    if(typeof Users[username] === 'undefined') {
      // user does not exist
      return res.redirect('/login-failed');
    }

    // Check is password is correct
    bcrypt.compare(password, Users[username]['password'], function(err, match) {
      if(match == false){
        // Password does not match
        return res.redirect('/login-failed');
      }

      var user = Users[username];
      user['id'] = username;

      // Make a token for the user
      var token = jwt.sign(user, secret);

      // return the information including token as JSON
      var sendThis = {
        success: true,
        message: 'Welcome To mStream',
        token: token };

      res.send(JSON.stringify(sendThis));

    });
  });

  // Guest Users are not allowed to access these functions
  const forbiddenFunctions = ['/db/recursive-scan', '/saveplaylist', '/deleteplaylist'];

  // Middleware that checks for token
  mstream.use(function(req, res, next) {
    // check header or url parameters or post parameters for token
    var token = req.body.token || req.query.token || req.headers['x-access-token'];

    // decode token
    if (!token) {
      return res.redirect('/access-denied');
    }

    // verifies secret and checks exp
    jwt.verify(token, secret, function(err, decoded) {
      if (err) {
        return res.redirect('/access-denied');
      }

      // Deny guest access
      req.decoded = decoded;
      if(decoded.guest === true && forbiddenFunctions.indexOf(req.path) != -1){
        return res.redirect('/guest-access-denied');
      }

      next();
    });
  });


  // TODO:  Authenticate all HTTP requests for music files (mp3 and other formats)
}



// Test function
// Used to determine the user has a working login token
mstream.get('/ping', function(req, res){
  res.send('pong');
});



// parse directories
mstream.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // Make sure directory exits
  var path =  req.body.dir;
  if(path == ""){
    path = rootDir;
  }else{
    path = fe.join(rootDir, path);
  }

  // Will only show these files.  Prevents people from snooping around
  // TODO: Move to global vairable
  var masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
  var fileTypesArray;

  if(req.body.filetypes){
    fileTypesArray = JSON.parse(req.body.filetypes);
  }else{
    fileTypesArray = masterFileTypesArray;
  }


  // Make sure it's a directory
  if(!fs.statSync( path).isDirectory()){
    // TODO: Write an error output
    // 500 Output?
    res.send("");
    return;
  }

  // get directory contents
  var files = fs.readdirSync( path);

  // loop through files
  for (var i=0; i < files.length; i++) {
    var tempDirArray = {};
    var tempFileArray = {};

  	var filePath = fe.join(path, files[i]);
    try{
      var stat = fs.statSync(filePath);
    }catch(error){
      // Bad file, ignore and continue
      // TODO: Log This
      continue;
    }


    // Handle Directories
  	if(stat.isDirectory()){
		  tempDirArray["type"] = 'directory';
		  tempDirArray["name"] = files[i];

  		directories.push(tempDirArray);
  	}else{ // Handle Files

      // Get the file extension
      var extension = getFileType(files[i]);


      if (fileTypesArray.indexOf(extension) > -1 && masterFileTypesArray.indexOf(extension) > -1) {
        tempFileArray["type"] = extension;
        tempFileArray["name"] = files[i];

        filesArray.push(tempFileArray);
      }
    }

  }


  var returnPath = slash( fe.relative(rootDir, path) );

  if(returnPath.slice(-1) !== '/'){
    returnPath += '/';
  }
  // Combine list of directories and mp3s
  var finalArray = { path:returnPath, contents:filesArray.concat(directories)};
  // Send back some JSON
  res.send(JSON.stringify(finalArray));

});



function getFileType(filename){
  return filename.split(".").pop();
}




mstream.post('/saveplaylist', function (req, res){
  var title = req.body.title;
  var songs = req.body.stuff;

  // Check if this playlist already exists
  db.all("SELECT id FROM mstream_playlists WHERE playlist_name = ?;", title, function(err, rows) {

    db.serialize(function() {

      // We need to delete anys existing entries
      if(rows && rows.length > 0){
        db.run("DELETE FROM mstream_playlists WHERE playlist_name = ?;", title);
      }

      // Now we add the new entries
      var sql2 = "insert into mstream_playlists (playlist_name, filepath) values ";
      var sqlParser = [];

      while(songs.length > 0) {
        var song = songs.shift();

        sql2 += "(?, ?), ";
        sqlParser.push(title);
        sqlParser.push( fe.join(rootDir, song)  );
      }

      sql2 = sql2.slice(0, -2);
      sql2 += ";";

      db.run(sql2, sqlParser, function(){
        res.send('DONE');
      });

    });
  });
});


mstream.get('/getallplaylists', function (req, res){

  // TODO: In V2 we need to change this to ignore hidden playlists
  // TODO: db.all("SELECT DISTINCT playlist_name FROM mstream_playlists WHERE hide=0;", function(err, rows){
  db.all("SELECT DISTINCT playlist_name FROM mstream_playlists", function(err, rows){
    var playlists = [];

    // loop through files
    for (var i = 0; i < rows.length; i++) {
      if(rows[i].playlist_name){
        playlists.push({name: rows[i].playlist_name});
      }
    }

    res.send(JSON.stringify(playlists));
  });
});

mstream.get('/loadplaylist', function (req, res){
  var playlist = req.query.playlistname;

  db.all("SELECT * FROM mstream_playlists WHERE playlist_name = ? ORDER BY id  COLLATE NOCASE ASC", playlist, function(err, rows){
    var returnThis = [];

    for (var i = 0; i < rows.length; i++) {

      // var tempName = rows[i].filepath.split('/').slice(-1)[0];
      var tempName = fe.basename(rows[i].filepath);
      var extension = getFileType(rows[i].filepath);
      var filepath = slash(fe.relative(rootDir, rows[i].filepath));

      returnThis.push({name: tempName, file: filepath, filetype: extension });
    }

    res.send(JSON.stringify(returnThis));
  });

});


mstream.get('/deleteplaylist', function(req, res){
  var playlistname = req.query.playlistname;

  // Handle a soft delete
  if(req.query.hide && parseInt(req.query.hide) === 1 ){
    db.run("UPDATE mstream_playlists SET hide = 1 WHERE playlist_name = ?;", playlistname, function(){
      res.send('DONE');

    });
  }else{ // Permentaly delete

    // Delete playlist from DB
    db.run("DELETE FROM mstream_playlists WHERE playlist_name = ?;", playlistname, function(){
      res.send('DONE');

    });
  }


});


// Download a zip file of music
mstream.post('/download',  function (req, res){
  var archive = archiver('zip');


  archive.on('error', function(err) {
    console.log(err.message);
    res.status(500).send('{error: err.message}');
  });

  archive.on('end', function() {
    // TODO: add logging
    console.log('Archive wrote %d bytes', archive.pointer());
  });

  //set the archive name
  // TODO: Rename this
  res.attachment('zipped-playlist.zip');

  //streaming magic
  archive.pipe(res);

  // Get the POSTed files
  var fileArray = JSON.parse(req.body.fileArray);


  // TODO:  Confirm each item in posted data is a real file //
  ///////////////////////////////////////////////////////////

  for(var i in fileArray) {
    var fileString = fileArray[i];
    archive.file(fe.normalize( fileString), { name: fe.basename(fileString) });
  }


  // TODO: Recursivly download a posted directory //
  //////////////////////////////////////////////////
  // SEE: https://github.com/archiverjs/node-archiver/tree/master/examples
  // var directory = req.body.directory;

  archive.finalize();
});



if(program.beetspath){
  const spawn = require('child_process').spawn;

  var scanThisDir = program.beetspath;


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

}else{
  const metadata = require('musicmetadata'); // TODO: Look into replacing with taglib
  var arrayOfSongs = [];

  // scan and screate database
  mstream.get('/db/recursive-scan', function(req,res){

    // Check if this is already running
    if(scanLock === true){
      // Return error
      res.status(401).send('{"error":"Scan in progress"}');
      return;
    }

    try{
      // turn on scan lock
      scanLock = true;


      // Make sure directory exits
      var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];



      countFiles(rootDir, fileTypesArray);

      totalFileCount = yetAnotherArrayOfSongs.length;

      db.serialize(function() {
        // These two queries will run sequentially.
        db.run("drop table if exists items;");
        db.run("CREATE TABLE items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
          // These queries will run in parallel and the second query will probably
          // fail because the table might not exist yet.
          console.log('TABLES CREATED');

          parse = parseAllFiles();
          parse.next();

        });
      });




    }catch(err){
      // Remove lock
      scanLock = false;

      // // Log error
      // res.status(500).send('{"error":"'+err+'"}');
      // console.log(err);
      return;
    }

    res.send("Scan Started");

  });





  function parseFile(thisSong){
    var readableStream = fs.createReadStream(thisSong);
    var parser = metadata(readableStream, function (err, songInfo) {
      if(err){
        // TODO: Do something
      }


      // TODO: Hash the file here and add the hash to the DB


      // Close the stream
      readableStream.close();


      console.log(songInfo);



      songInfo.filePath = thisSong;
      songInfo.format = getFileType(thisSong);

      arrayOfSongs.push(songInfo);


      // if there are more than 100 entries, or if it's the last song
      if(arrayOfSongs.length > 99){
        insertEntries();
      }

      // For the generator
      parse.next();
    });
  }

  function *parseAllFiles(){

    // Loop through local items
    while(yetAnotherArrayOfSongs.length > 0) {
      var file = yetAnotherArrayOfSongs.pop();

      var resultX = yield parseFile(file);

    }

    insertEntries();
    scanLock = false;
  }


  var parse;



  // Insert
  function insertEntries(){
    var sql2 = "insert into items (title,artist,year,album,path,format, track, disk) values ";
    var sqlParser = [];

    while(arrayOfSongs.length > 0) {
      var song = arrayOfSongs.pop();

      // console.log(song);


      var songTitle = null;
      var songYear = null;
      var songAlbum = null;
      var artistString = null;

      if(song.artist && song.artist.length > 0){
        artistString = '';
        for (var i = 0; i < song.artist.length; i++) {
          artistString += song.artist[i] + ', ';
        }
        artistString = artistString.slice(0, -2);
      }
      if(song.title && song.title.length > 0){
        songTitle = song.title;
      }
      if(song.year && song.year.length > 0){
        songYear = song.year;
      }
      if(song.album && song.album.length > 0){
        songAlbum = song.album;
      }


      sql2 += "(?, ?, ?, ?, ?, ?, ?, ?), ";
      sqlParser.push(songTitle);
      sqlParser.push(artistString);
      sqlParser.push(songYear);
      sqlParser.push(songAlbum);
      sqlParser.push(song.filePath);
      sqlParser.push(song.format);
      sqlParser.push(song.track.no);
      sqlParser.push(song.disk.no);

    }

    sql2 = sql2.slice(0, -2);
    sql2 += ";";

    console.log(sql2);
    db.run(sql2, sqlParser);
  }


  //  Count all files
  function countFiles (dir, fileTypesArray) {
    var files = fs.readdirSync( dir );


    for (var i=0; i < files.length; i++) {
      var filePath = fe.join(dir, files[i]);
      var stat = fs.statSync(filePath);

      if(stat.isDirectory()){
        countFiles(filePath , fileTypesArray);
      }else{
        var extension = getFileType(files[i]);

        if (fileTypesArray.indexOf(extension) > -1 ) {

          yetAnotherArrayOfSongs.push(filePath);
        }
      }

    }
  }

}











mstream.post('/db/search', function(req, res){
  var searchTerm = "%" + req.body.search + "%" ;

  var returnThis = {"albums":[], "artists":[]};

  // TODO: Combine SQL calls into one
  db.serialize(function() {

    var sqlAlbum = "SELECT DISTINCT album FROM items WHERE items.album LIKE ? ORDER BY album  COLLATE NOCASE ASC;";
    db.all(sqlAlbum, searchTerm, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      for (var i = 0; i < rows.length; i++) {
        if(rows[i].album){
          // rows.splice(i, 1);
          returnThis.albums.push(rows[i].album);
        }
      }
    });


    var sqlAlbum = "SELECT DISTINCT artist FROM items WHERE items.artist LIKE ? ORDER BY artist  COLLATE NOCASE ASC;";
    db.all(sqlAlbum, searchTerm, function(err, rows) {
      if(err){
        res.status(500).json({ error: 'DB Error' });
        return;
      }

      for (var i = 0; i < rows.length; i++) {
        if(rows[i].artist){
          // rows.splice(i, 1);
          returnThis.artists.push(rows[i].artist);
        }
      }

      res.send(JSON.stringify(returnThis));

    });
  });
});



mstream.get('/db/artists', function (req, res) {
  var sql = "SELECT DISTINCT artist FROM items ORDER BY artist  COLLATE NOCASE ASC;";

  var artists = {"artists":[]};

  db.all(sql, function(err, rows) {
    if(err){
      res.status(500).json({ error: 'DB Error' });
      return;
    }

    var returnArray = [];
    for (var i = 0; i < rows.length; i++) {
      if(rows[i].artist){
        // rows.splice(i, 1);
        artists.artists.push(rows[i].artist);
      }
    }

    res.send(JSON.stringify(artists));
  });
});



mstream.post('/db/artists-albums', function (req, res) {
  var sql = "SELECT DISTINCT album FROM items WHERE artist = ? ORDER BY album  COLLATE NOCASE ASC;";

  var searchTerm = req.body.artist ;

  var albums = {"albums":[]};

  // TODO: Make a list of all songs without null albums and add them to the response


  db.all(sql, searchTerm, function(err, rows) {
    if(err){
      res.status(500).json({ error: 'DB Error' });
      return;
    }


    var returnArray = [];
    for (var i = 0; i < rows.length; i++) {
      if(rows[i].album){
        // rows.splice(i, 1);
        albums.albums.push(rows[i].album);
      }
    }

    res.send(JSON.stringify(albums));
  });
});



mstream.get('/db/albums', function (req, res) {
  var sql = "SELECT DISTINCT album FROM items ORDER BY album  COLLATE NOCASE ASC;";

  var albums = {"albums":[]};


  db.all(sql, function(err, rows) {
    if(err){
      res.status(500).json({ error: 'DB Error' });
      return;
    }


    var returnArray = [];
    for (var i = 0; i < rows.length; i++) {
      if(rows[i].album){
         albums.albums.push(rows[i].album);

      }
    }

    console.log(JSON.stringify(albums));
    res.send(JSON.stringify(albums));
  });
});



mstream.post('/db/album-songs', function (req, res) {
  var sql = "SELECT title, artist, album, format, year, cast(path as TEXT), track FROM items WHERE album = ? ORDER BY track ASC;";
  var searchTerm = req.body.album ;



  db.all(sql, searchTerm, function(err, rows) {
    if(err){
      res.status(500).json({ error: 'DB Error' });
      return;
    }

    // Format data for API
    rows  = setLocalFileLocation(rows);


    res.send(JSON.stringify(rows));
  });
});




function setLocalFileLocation(rows){

  for(var i in rows ){
    var path = String(rows[i]['cast(path as TEXT)']);

    rows[i].format = rows[i].format.toLowerCase();  // make sure the format is lowecase
    rows[i].file_location = slash(fe.relative(rootDir, path)); // Get the local file location
    rows[i].filename = fe.basename( path );  // Ge the filname
  }

  return rows;
}



// GET DB Status
mstream.get('/db/status', function(req, res){
  var returnObject = {};

  returnObject.locked = scanLock;


  if(scanLock){

    // Currently we don't support filecount stats when using beets DB
    if(!program.beetspath){
      returnObject.totalFileCount = totalFileCount;
      returnObject.filesLeft = yetAnotherArrayOfSongs.length;
    }else{
      // Dummy data
      returnObject.totalFileCount = 0;
      returnObject.filesLeft = 0;
    }


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




// TODO: Add individual song
// mstream.get('/db/add-songs', function(req, res){
//     // deseralize json array
//     // Add all files
// });


// Download the database
mstream.get('/db/download-db', function(req, res){
  var file =  program.database;

  res.download(file); // Set disposition and send it.
});


// Get hash of database
mstream.get( '/db/hash', function(req, res){
  var hash = crypto.createHash('sha256');
  var fileStream = fs.createReadStream(program.database);

  hash.setEncoding('hex');
  fileStream.pipe(hash, { end: false });


  fileStream.on('end', function () {
    hash.end();

    var returnThis = {
      hash:String(hash.read())
    };

    res.send(JSON.stringify(returnThis));

  });
});


const server = mstream.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);
});
