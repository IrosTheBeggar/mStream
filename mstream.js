#!/usr/bin/env node
"use strict";

const express = require('express');
const mstream = express();
const fs = require('graceful-fs');  // File System
const fe = require('path');
const bodyParser = require('body-parser');
const archiver = require('archiver');  // Zip Compression
const os = require('os');
const crypto = require('crypto');
const slash = require('slash');
// const sqlite3 = require('sqlite3').verbose();


var startup = 'configure-commander';
// If the user gives a json file then try pulling the config from that
try{
  if(fe.extname(process.argv[process.argv.length-1]) == '.json'  &&  fs.statSync(process.argv[process.argv.length-1]).isFile()){
    startup = 'configure-json-file';
  }
}catch(error){
  console.log('JSON file does not appear to exist');
  process.exit();
}

const program = require('./modules/' + startup + '.js').setup(process.argv);
if(program == false){
  process.exit();
}
// const db = new sqlite3.Database(program.database);


// TODO: Move these to db modules
// // If we are not using Beets DB, we need to prep the DB
// if(program.databaseplugin === 'default'){
//   db.run("CREATE TABLE IF NOT EXISTS items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
//     // console.log('TABLES CREATED');
//   });
// }
// // Create a playlist table
// db.run("CREATE TABLE IF NOT EXISTS mstream_playlists (  id INTEGER PRIMARY KEY AUTOINCREMENT,  playlist_name varchar,  filepath varchar, hide int DEFAULT 0, created datetime default current_timestamp);",  function() {
//   // console.log('PLAYLIST TABLE CREATED');
// });




// Normalize for all OS
// Make sure it's a directory
// Loop through and makeure all user Dirs are real
if(program.users){
  for (i = 0; i < program.users.length; i++) {
    //TODO: Check usernames for forbidden chars

    // TODO: Assure all usernames are unique
      // TODO: Or update JSON so usernames have to be unique

    // TODO: Assure only one user per filepath

    // TODO: Assure all users are usingthe same DB schema

    if(!fs.statSync( program.users[i].musicDir ).isDirectory()){
      console.log(program.users[i].username +  " music directory could not be found");
      process.exit();
    }
  }
}else if(!fs.statSync( program.filepath ).isDirectory()){
  console.log('GIVEN DIRECTORY DOES NOT APPEAR TO BE REAL');
  process.exit();
}



if(program.user && program.password){
  // Move program.username and program.password to program.users
  var newUser = {
    "username":program.user,
    "password":program.password,
    "musicDir":program.filepath
  };

  if(program.email){
    newUser.email = program.email
  }

  // TODO: Handle Guest Account
  // if(program.guest && program.guestPassword){

  // }

  program.users.push(newUser);
}


// Check that this is a real dir
if(!fs.statSync( fe.join(__dirname, program.userinterface) ).isDirectory()){
  console.log('The userinterface was not found.  Closing...');
  process.exit();
}

// Static files
// TODO: Loop through and create sperate virtual paths for all user dirs
mstream.use( express.static(fe.join(__dirname, program.userinterface) ));
if(program.users){
  for (i = 0; i < program.users.length; i++) {
    // TODO: Check if musicDir is real

    mstream.use( '/' + program.users[i].username + '/' , express.static( program.users[i].musicDir  ));
  }
}else{
  var rootDir = fe.normalize(program.filepath);
  // Normalize It
  if(!fe.isAbsolute(program.filepath) ){
    rootDir = fe.join(process.cwd,   rootDir);
  }
  mstream.use( '/'  , express.static( rootDir  ));
}

// Magic Middleware Things
mstream.use(bodyParser.json()); // support json encoded bodies
mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies


// Handle ports. Default is 3000
const port = program.port;
console.log('Access mStream locally: http://localhost:' + port);


// Handle Port Forwarding
// TODO: Portforwarding could use a feature that re-opens it on a timed interval
// TODO: Switch between uPNP and nat-pmp
if(program.tunnel){
  const tunnel = require('./modules/auto-port-forwarding.js');
  tunnel.tunnel_uPNP(program.port);
  tunnel.logUrl(port);
}

// Print the local network IP
console.log('Access mStream on your local network: http://' + require('my-local-ip')() + ':' + port);



// Serve the webapp
mstream.get('/', function (req, res) {
	res.sendFile(  fe.join(program.userinterface, 'mstream.html'), { root: __dirname });
});



// Login functionality
if(program.users){

  // TODO: password change function
  if(program.email){
    mstream.post('/change-password-request', function (req, res) {
      // Get email address from request
        // validate email against user array

      // Generate change password token

      // Invalidate all other change password tokens

      // Email the user the token

    	res.sendFile( 'COMING SOON!' );
    });


    // TODO: Add New user
      // Check for root user and password
      // Add credentials to user array

    mstream.post('/change-password', function (req, res){
      // Check token

      // Get new password

      // Hash password and update user array

      res.sendFile( 'COMING SOON!' );
    });
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
    secret = fs.readFileSync(program.secret, 'utf8');
  }else if(program.secret){
    secret = String(program.secret);
  }else{
    require('crypto').randomBytes(48, function(err, buffer) {
      secret = buffer.toString('hex');
    });
  }

  // Create the user array
  var Users = {};

  // TODO: Construct user array
  for (i = 0; i < program.users.length; i++) {
    Users[program.users[i].username] = {
      "musicDir":program.users[i].musicDir,
    }

    if(program.users[i].email){
      Users[program.users[i].username].email = program.users[i].email;
    }
  }
  // Users[program.user] = {
  //   "guest": false,
  //   "guestPassword":"",
  //   "password":'',
  //   "email":"",
  //   "musicDir":"",
  //
  // }

  // TODO: Break salt generation and password management into a loop and seperate function
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
      if(decoded.guest === true && forbiddenFunctions.indexOf(req.path) != -1){
        return res.redirect('/guest-access-denied');
      }

      // Set user request data
      req.user = decoded;


      next();
    });
  });


  // TODO:  Authenticate all HTTP requests for music files (mp3 and other formats)
}else{

  // Dummy data
  mstream.use(function(req, res, next) {
    req.user = {
      "username":"",
      "musicDir":program.filepath
    };
    next();
  });

}



// Test function
// Used to determine the user has a working login token
// TODO: This will return the virtual file path directory needed to access msuci files
mstream.get('/ping', function(req, res){
  var returnObject = {
    'vPath' = req.user.username,
    'guest' = false, // TODO: return guest status
  };
  res.send(JSON.stringify(returnObject);
});



// parse directories
mstream.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // Make sure directory exits
  // TODO Get music dir from request
  var path = fe.join(req.user.musicDir, req.body.dir);
  // if(path == ""){
  //   path = rootDir;
  // }else{
  //   path = fe.join(rootDir, path);
  // }

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

  // TODO: rootdir stuff here
  var returnPath = slash( fe.relative(req.user.musicDir, path) );

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



// TODO: Save playlist according to user and the user's music DIR
mstream.post('/saveplaylist', function (req, res){
  var title = req.body.title;
  var songs = req.body.stuff;

  // Check if this playlist already exists
  // TODO: Add field for username
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
        sqlParser.push( fe.join(req.user.musicDir, song)  ); // TODO: User music dir
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
      var filepath = slash(fe.relative(req.user.musicDir, rows[i].filepath)); // TODO

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


// Old way
//const mstreamDB = require('./modules/database-'+program.databaseplugin+'.js');
// mstreamDB.setup(mstream, program.users, db); // TODO: ROOTDIR

// New Way
var publicDBType = 'sqlite3'; // Can be sqlite3/mysql/LokiJS
const mstreamDB = require('./modules/database-master.js');
mstreamDB.setup(mstream, program.users, publicDBType);


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
    // rows  = setLocalFileLocation(rows);
    for(var i in rows ){
      var path = String(rows[i]['cast(path as TEXT)']);

      rows[i].format = rows[i].format.toLowerCase();  // make sure the format is lowecase
      rows[i].file_location = slash(fe.relative(req.user.musicDir, path)); // Get the local file location
      rows[i].filename = fe.basename( path );  // Ge the filname
    }


    res.send(JSON.stringify(rows));
  });
});



// // TODO
// function setLocalFileLocation(rows){
//
//   for(var i in rows ){
//     var path = String(rows[i]['cast(path as TEXT)']);
//
//     rows[i].format = rows[i].format.toLowerCase();  // make sure the format is lowecase
//     rows[i].file_location = slash(fe.relative(rootDir, path)); // Get the local file location
//     rows[i].filename = fe.basename( path );  // Ge the filname
//   }
//
//   return rows;
// }






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


// TODO: Get Album Art calls
mstream.post( '/get-album-art', function(req, res){
  // Get filepath from post

  // Check if album art is in DB
    // Return If So

  // Pull album art from file stream

  // ??? Lookup album art via 3rd party ???

  res.send('Coming Soon!');

}

const server = mstream.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);
});
