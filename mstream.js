#!/usr/bin/env node
"use strict";

var express = require('express');
var mstream = express();
var fs = require('graceful-fs');  // File System
var fe = require('path');
var bodyParser = require('body-parser');
var program = require('commander');  // Command Line Parser
var archiver = require('archiver');  // Zip Compression
var os = require('os');
var crypto = require('crypto');


// Setup Command Line Interface
program
  .version('1.15.0')
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
  .option('-d, --database <path>', 'Add SSL Certificate', 'mstreamdb.lite')
  .parse(process.argv);



// TODO: Cleanup global vars
// For DB
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database(program.database);
var metadata = require('musicmetadata'); // TODO: Look into replacing with taglib
var scanLock = false;

var arrayOfSongs = [];

db.run("CREATE TABLE IF NOT EXISTS items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
  // console.log('TABLES CREATED');
});



// Get starting directory from command line arguments
if(process.argv[2]){
  var startdir = process.argv[2];

  // Abort if supplied value is not a directory
  if(!fs.statSync(startdir ).isDirectory()){
    console.log('Could not find directory. Aborting.');
    process.exit(1);
  }
}else{
  console.log('No directory supplied... Aborting');
  console.log('Please use the following format: mstream musicDirectory/');
  process.exit(1);
}


// Add the slash at the end if it's not already there
if(startdir.slice(-1) !== '/'){
  startdir += '/';
}


// Normalize for all OS
startdir =  fe.normalize(startdir);
var rootDir = process.cwd() + startdir;


// Static files
mstream.use( express.static(__dirname + '/public'));
mstream.use( '/'  , express.static( process.cwd() + '/' + startdir));

// Magic Middleware Things
mstream.use(bodyParser.json()); // support json encoded bodies
mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies


// Handle ports. Default is 3000
var port = program.port;
console.log('Access mStream locally: http://localhost:' + port);


// Auto tunnel to the external world
if(program.tunnel){
  try{

    var natpmp = require('nat-pmp');

    // Use the user supplied Gateway IP or try to find it manually
    if(program.gateway){
      var gateway = program.gateway;
    }else{
      var netroute = require('netroute');
      var gateway = netroute.getGateway();
    }

    console.log('Attempting to tunnel via gateway: ' + gateway);

    var client = new natpmp.Client(gateway);
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
    console.log('WARNING: mStream tunnel functionality has failed.  Your network may not allow functionality');
    console.log(e);
  }
}


// TODO: Print the local network IP


// Login functionality
if(program.login){
  if(!program.password || !program.user){
    console.log('User credentials are missing.  Please make sure to supply both a username and password via the -u and -p commands respectivly.  Aborting');
    process.exit(1);
  }

  // Use bcrypt for password storage
  var bcrypt = require('bcrypt');

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


  // Setup Express-Session and Passpors
  var session = require('express-session'); // User Sessions
  var passport = require('passport');
  var LocalStrategy = require('passport-local').Strategy;
  // var cookieParser = require('cookie-parser');

  mstream.use(session({
    // name: 'mstream-session-grade',
    secret: 'tbg84e9q5gb8eiour8g3gnoiug0e4wu5ngiohn4',
    saveUninitialized: false,
    resave: false,
    // TODO: set secure when https is ready
  }));

  mstream.use(passport.initialize());
  mstream.use(passport.session()); // TODO: Remove this?
  // mstream.use(cookieParser());

  mstream.get('/login', function(req, res) {
    // render the page and pass in any flash data if it exists
    res.sendFile('public/login.html', { root: __dirname });
  });


  mstream.post('/login', passport.authenticate('local-login', {
      // TODO: Put a delay on the login function. Prevents brute force attacks
    //setTimeout(function(){
      successRedirect : '/', // redirect to the secure profile section
      failureRedirect : '/login', // redirect back to the signup page if there is an error
      //failureFlash : true // allow flash messages
    //}, 300);

  }));




  passport.serializeUser(function(user, done) {
    done(null, user.id);
  });

  // used to deserialize the user
  passport.deserializeUser(function(id, done) {
    var user = Users[id];
    user['id'] = id;
    done( null, user);
  });

  passport.use('local-login', new LocalStrategy({
    // by default, local strategy uses username and password, we will override with email
    usernameField : 'username',
    passwordField : 'password',
    passReqToCallback : true // allows us to pass back the entire request to the callback
  },
  function(req, username, password, done) { // callback with email and password from our form
    // TODO: Handle empty username

    // Check is user is in array
    if(typeof Users[username] === 'undefined') {
      // does not exist
      return done(null, false, { message: 'Incorrect password.' });
    }

    // Check is password is correct
    // if(Users[username]['password'] !== password){
    //   return done(null, false, { message: 'Incorrect password.' });
    // }
    bcrypt.compare(password, Users[username]['password'], function(err, res) {
      if(res==false){
        return done(null, false, { message: 'Incorrect password.' });

      }

      var user = Users[username];
      user['id'] = username;

      return done(null, user);
    });

  }));

  // Middleware that checks for user sessions
  function authenticateUser (req, res, next) {
    var authorizationStatus = req.isAuthenticated()
    if (authorizationStatus){
      return next();
    }
    res.redirect('/login');
  }
  // Enable middleware
  mstream.use(authenticateUser);




  // Middleware that deny's a guest account access to specific functions
  function denyGuest (req, res, next) {
    if(req.user.guest == false ){
      return next();
    }

    // Deny access to these functions
    var forbiddenFunctions = ['/db/recursive-scan', '/saveplaylist'];

    if(forbiddenFunctions.indexOf(req.path) == -1){
      return next();
    }


    res.redirect('/access-denied');
  }
  mstream.use(denyGuest);


  mstream.get('/access-denied', function (req, res) {
    res.status(500).send(JSON.stringify({'Error':'Access Denied'}));
  });


  // TODO:  Authenticate all HTTP requests for music files (mp3 and other formats)
}




// Serve the webapp
mstream.get('/', function (req, res) {
	res.sendFile('public/mstream.html', { root: __dirname });
});


// parse directories
mstream.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // Make sure directory exits
  var path =  req.body.dir;

  var fileTypesArray = JSON.parse(req.body.filetypes);
  // TODO: Use a default value if user doesn't supply this


  // Will only show these files.  Prevents people from snooping around
  // TODO: Move to global vairable
  var masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];


  // Make sure it's a directory
  if(!fs.statSync(startdir + path).isDirectory()){
    // TODO: Write an error output
    // 500 Output?
    res.send("");
    return;
  }

  // get directory contents
  var files = fs.readdirSync( startdir + path);

  // loop through files
  for (var i=0; i < files.length; i++) {
    var tempDirArray = {};
    var tempFileArray = {};

  	var filePath = startdir + path + files[i];
  	var stat = fs.statSync(filePath);


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

  // Combine list of directories and mp3s
  var finalArray = { path:path, contents:filesArray.concat(directories)};

  var returnJSON = JSON.stringify(finalArray);

  // Send back some JSON
  res.send(returnJSON);

});



function getFileType(filename){

  return filename.split(".").pop();
}




// playlist placeholder functions
// TODO: Change this to store playlists in DB
mstream.post('/saveplaylist', function (req, res){

  var title = req.body.title;
  var songs = req.body.stuff;

  try {
    fs.mkdirSync('.mstream-playlists');
  } catch(e) {
    if ( e.code != 'EEXIST' ) throw e;
  }

  var writeString = '';

  for(var i = songs.length - 1; i >= 0; i--) {
    writeString += songs[i] + os.EOL;
  }

  fs.writeFile('.mstream-playlists/' + title + '.m3u', writeString, function (err) {
    if (err) throw err;
    
    console.log('It\'s saved!');
    res.send();
  });
});



mstream.get('/getallplaylists', function (req, res){
  var files = fs.readdirSync('.mstream-playlists/');
  var playlists = [];

  // // loop through files
  for (var i = 0; i < files.length; i++) {
    if(files[i].substr(files[i].length - 3) === 'm3u'){
      playlists.push({file:files[i], name:files[i].slice(0, -4)});
    }
  }

  res.send(JSON.stringify(playlists));
});


// Find all playlists
mstream.get('/loadplaylist', function (req, res){
  // TODO: Scrub user input
  var playlist = req.query.filename;

  var contents = fs.readFileSync('.mstream-playlists/' + playlist,  'utf8');
  var contents = contents.split(os.EOL);

  var returnThis = [];

  for (var i = 0; i < contents.length; i++) {
    if(contents[i].length == 0){
      continue;
    }

    var tempName = contents[i].split('/').slice(-1)[0];
    var extension = getFileType(contents[i]);

    var tempObj = {name: tempName, file: contents[i], filetype: extension };


    returnThis.push(tempObj);
  }


  res.send(JSON.stringify(returnThis));
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
    archive.file(fe.normalize( startdir + fileString), { name: fe.basename(fileString) });
  }


  // TODO: Recursivly download a posted directory //
  //////////////////////////////////////////////////
  // SEE: https://github.com/archiverjs/node-archiver/tree/master/examples
  // var directory = req.body.directory;

  archive.finalize();
});






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



    countFiles(startdir, fileTypesArray);

    totalFileCount = yetAnotherArrayOfSongs.length;

    db.serialize(function() {
      // These two queries will run sequentially.
      db.run("drop table if exists items;");
      db.run("CREATE TABLE items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
        // These queries will run in parallel and the second query will probably
        // fail because the table might not exist yet.
        console.log('TABLES CREATED');
        // var emptypromise = emptyPromise();
        // recursiveScanY(startdir, fileTypesArray, emptypromise);  // TODO: Can we remove the fileTypesArray?
        
        parse = parseAllFiles();
        parse.next();

      });
    });


  }catch(err){
    // Remove lock
    scanLock = false;

    // Log error
    res.status(500).send('{"error":"'+err+'"}');
    console.log(err);
    return;
  }


  res.send("YA DID IT");

});





function parseFile(thisSong){

  // TODO: Test what happens when an error occurs
  var parser = metadata(fs.createReadStream(thisSong), {autoClose: true}, function (err, songInfo) {

    console.log(songInfo);


    if(err){
      // TODO: Do something
    }


    songInfo.filePath = rootDir + thisSong.substring(startdir.length);
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

  // // Loop through local items
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



var yetAnotherArrayOfSongs = [];
var totalFileCount = 0;

//  Count all files
function countFiles (dir, fileTypesArray) {
  var files = fs.readdirSync( dir );


  for (var i=0; i < files.length; i++) {
    var filePath = dir + files[i];
    var stat = fs.statSync(filePath);

    if(stat.isDirectory()){
      countFiles(filePath + '/', fileTypesArray);
    }else{
      var extension = getFileType(files[i]);

      if (fileTypesArray.indexOf(extension) > -1 ) {

        yetAnotherArrayOfSongs.push(filePath);
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
  var n = rootDir.length;

  for(var i in rows ){
    var path = String(rows[i]['cast(path as TEXT)']);

    rows[i].format = rows[i].format.toLowerCase();  // make sure the format is lowecase
    rows[i].file_location = path.substring(n); // Get the local file location
    rows[i].filename = path.split("/").pop();  // Ge the filane
  }

  return rows;
}



// GET DB Status
mstream.get('/db/status', function(req, res){
  var returnObject = {};
  
  returnObject.locked = scanLock;


  if(scanLock){
    returnObject.totalFileCount = totalFileCount;
    returnObject.filesLeft = yetAnotherArrayOfSongs.length;

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


var server = mstream.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);
});
