#!/usr/bin/env node

var express = require('express');
var app = express();
var fs = require('graceful-fs');  // File System
var fe = require('path');
var bodyParser = require('body-parser');
var program = require('commander');  // Command Line Parser
var archiver = require('archiver');  // Zip Compression
var os = require('os');



// For DB
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('mstreamdb.lite');
var metadata = require('musicmetadata'); // TODO: Look into replacng with taglib
var scanLock = false;
var fileCount = 0;
var fileCounter = 0;
var arrayOfSongs = [];


// Setup Command Line Interface
program
  .version('1.9.0')
  .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
  .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
  .option('-g, --gateip <gateip>', 'Manually set gateway IP for the tunnel option')
  .option('-l, --login', 'Require users to login')
  .option('-u, --user <user>', 'Set Username')
  .option('-x, --password <password>', 'Set Password')
//  .option('-d, --database')
//  .option('-s, --ssl', 'Setup SSL')
  .option('-k, --key <key>', 'Add SSL Key')
  .option('-c, --cert <cert>', 'Add SSL Certificate')
//  .option('-d, --db <path>', 'Add SSL Certificate', mstreamdb.lite)
  .parse(process.argv);




// Get starting directory from command line arguments
if(process.argv[2]){
  var startdir = process.argv[2];
  if(!fs.statSync(startdir ).isDirectory()){
    console.log('Could not find directory. Aborting.');
    process.exit(1);
  }
}else{
  console.log('No directory supplied... Aborting');
  console.log('Please use the following format: mstream musicDirectory/');
  process.exit(1);
}

// Make sure the user supplied a real directory
if(!fs.statSync(startdir).isDirectory()){
  console.log('Could not find the supplied directory');
  console.log('Please use the following format: mstream musicDirectory/');
  process.exit(1);
}

// Add the slash at the end if it's not already there
if(startdir.slice(-1) !== '/'){
  startdir += '/';
}
// Normalize for all OS
startdir =  fe.normalize(startdir);

// Static files
app.use( express.static(__dirname + '/public'));
app.use( '/'  , express.static( process.cwd() + '/' + startdir));

// Magic Middleware Things
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

// Handle ports. Default is 3000
var port = program.port;

console.log('Access mStream locally: http://localhost:' + port);


// Auto tunnel to the external world
try{
  if(program.tunnel){
    var natpmp = require('nat-pmp');

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
}
catch (e) {
  console.log('WARNING: mStream tunnel functionality has failed.  This feature is still experimental');
  console.log(e);
}

// TODO: Print the local network IP


//////////////////////////////////////////////////
//////////////////////////////////////////////////
//////////////////////////////////////////////////
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
    'download': 1,
    'password':'',
  }

  // Encrypt the password
  bcrypt.genSalt(10, function(err, salt) {
    bcrypt.hash(program.password, salt, function(err, hash) {
      // Store hash in your password DB. 
      Users[program.user]['password'] = hash;
    });
  });


  // Setup Express-Session and Passpors
  var session = require('express-session'); // User Sessions
  var passport = require('passport');
  var LocalStrategy = require('passport-local').Strategy;
  // var cookieParser = require('cookie-parser');

  app.use(session({
    // name: 'mstream-session-grade',
    secret: 'tbg84e9q5gb8eiour8g3gnoiug0e4wu5ngiohn4',
    saveUninitialized: false,
    resave: false,
    // TODO: set secure when https is ready
  }));

  app.use(passport.initialize());
  app.use(passport.session()); // TODO: Remove this?
  // app.use(cookieParser());

  app.get('/login', function(req, res) {
    // render the page and pass in any flash data if it exists
    res.sendFile('public/login.html', { root: __dirname });
  });


  app.post('/login', passport.authenticate('local-login', {
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
  app.use(authenticateUser);

  // TODO:  Authenticat all HTTP requests for music files (mp3 and other formats) 
}






// Serve the webapp
app.get('/', function (req, res) {
	res.sendFile('public/mstream.html', { root: __dirname }); 
});


// parse directories
app.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // Make sure directory exits
  var path =  req.body.dir;

  var fileTypesArray = JSON.parse(req.body.filetypes);

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
      // Make list of mp3 files
      // if(files[i].substr(files[i].length - 3) === 'mp3'){
      //  tempFileArray["type"] = 'mp3';
      //  tempFileArray["name"] = files[i];

      //  filesArray.push(tempFileArray);
      // }

      // Get the last three letters of files
      var extension = getFileType(files[i]);
      // var extension = files[i].substr(files[i].length - 3);
      // // compensate for flac
      // if(extension === 'lac'){
      //   extension = 'flac';
      // }

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
  var extension = filename.substr(filename.length - 3);
  // compensate for flac
  if(extension === 'lac'){
      extension = 'flac';
  }

  return extension;
}




// playlist placeholder functions
app.post('/saveplaylist', function (req, res){

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


app.get('/getallplaylists', function (req, res){
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
app.get('/loadplaylist', function (req, res){
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
app.post('/download',  function (req, res){
  var archive = archiver('zip');


  archive.on('error', function(err) {
    console.log(err.message);
    res.status(500).send({error: err.message});
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
app.get('/db/recursive-scan', function(req,res){

    // Check if this is already running
    if(scanLock === true){
        // Return error
        res.status(401).send('{"error":"Scan in progress"}');
        return;
    }

    try{
        // turn on scan lock
        scanLock = true;

        //
        fileCount = 0;
        fileCounter = 0;

        // Make sure directory exits
        var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];

        if(!fs.statSync( startdir).isDirectory()){
            // TODO: Write an error output
            // 500 Output?
            scanLock = false;
            res.send("");
            return;
        }

        countFiles(startdir, fileTypesArray);
        console.log(fileCount);




        db.serialize(function() {
            // These two queries will run sequentially.
            db.run("drop table if exists files;");
            db.run("CREATE TABLE files (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL, filename varchar,  file_location text, filetype varchar);",  function() {
                // These queries will run in parallel and the second query will probably
                // fail because the table might not exist yet.
                recursiveScan(startdir, fileTypesArray);

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



function recursiveScan(dir, fileTypesArray){
    var files = fs.readdirSync( dir );


    // loop through files
    for (var i=0; i < files.length; i++) {
        console.log(files[i]);
        var filePath = dir + files[i];
        var stat = fs.statSync(filePath);

        console.log(stat);

        if(stat.isDirectory()){  
            recursiveScan(filePath + '/', fileTypesArray); 
        }else{
            var extension = getFileType(files[i]);

            // Make sure this is in our list of allowed files
            if (fileTypesArray.indexOf(extension) > -1 ) {
                parseFile(filePath, files[i], extension);

            } 
        }

    }

}



// Counts the number of open files
var maxFileCounterThing = 0;



// This function checks if there's too many files open 
function parseFile(filePath, filename, extension){

    // Limits number offiles open
    if(maxFileCounterThing > 150){

        // Wait 3 seconds and try again.  TODO: Make this a config variable 
        setTimeout(function () {
          parseFile(filePath, filename, extension)
        }, 3000);
    }else{
        // Increment counter
        maxFileCounterThing++;
        // Parse file
        parseFile2(filePath, filename, extension);
    }

}

// Pull song info from file
function parseFile2(filePath, filename, extension){

    // TODO: Test what happens when an error occurs
    var parser = metadata(fs.createReadStream(filePath), function (err, songInfo) {
        fileCounter++;

        console.log(songInfo);


        if(err){
            // TODO: Do something
        }


        songInfo.filePath = filePath.substring(startdir.length);
        songInfo.filename = filename;
        songInfo.filetype = extension;

        arrayOfSongs.push(songInfo);


        // if there are more than 20 entries, or if it's the last song
        if(arrayOfSongs.length > 100 || fileCounter == fileCount){
            insertEntries();
        }

        // Remove the scanlock if it's the last song
        if(fileCounter == fileCount){
          scanLock = false;
        }

        // 
        maxFileCounterThing--;

    }); 
}

// Insert
function insertEntries(){
    var sql2 = "insert into files (title,artist,year,album,filename,file_location,filetype) values ";
    var sqlParser = [];

    while(arrayOfSongs.length > 0) {
        var song = arrayOfSongs.pop();

        console.log(song);


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


        sql2 += "(?, ?, ?, ?, ?, ?, ?), ";
        sqlParser.push(songTitle);
        sqlParser.push(artistString);
        sqlParser.push(songYear);
        sqlParser.push(songAlbum);
        sqlParser.push(song.filename);
        sqlParser.push(song.filePath);
        sqlParser.push(song.filetype);


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
        var filePath = dir + files[i];
        var stat = fs.statSync(filePath);

        if(stat.isDirectory()){  
            countFiles(filePath + '/', fileTypesArray); 
        }else{
            var extension = getFileType(files[i]);
            // var extension = files[i].substr(files[i].length - 3);
            // // compensate for flac
            // if(extension === 'lac'){
            //   extension = 'flac';
            // }

            if (fileTypesArray.indexOf(extension) > -1 ) {
                fileCount++;
            } 
        }

    }
}





// TODO: Search
app.post('/db/search', function(req, res){
    var searchTerm = "%" + req.body.search + "%" ;
    console.log(searchTerm);

    var artists;
    var albums;

    var returnThis = {"albums":[], "artists":[]};

    // TODO: Combine SQL calls into one
    db.serialize(function() {
        var sqlAlbum = "SELECT DISTINCT album FROM files WHERE files.album LIKE ? ORDER BY album  COLLATE NOCASE ASC;";
        db.all(sqlAlbum, searchTerm, function(err, rows) {
            console.log(err);
            console.log(rows);

            for (var i = 0; i < rows.length; i++) {
                if(rows[i].album){
                   // rows.splice(i, 1);
                   returnThis.albums.push(rows[i].album);
                }
            }
        });


        var sqlAlbum = "SELECT DISTINCT artist FROM files WHERE files.artist LIKE ? ORDER BY artist  COLLATE NOCASE ASC;";
        db.all(sqlAlbum, searchTerm, function(err, rows) {
            console.log(err);
            console.log(rows);
            artists = rows;

            console.log('XXXXXXYYYYYYYZZZZZZZZ');

            for (var i = 0; i < rows.length; i++) {
                if(rows[i].artist){
                    // rows.splice(i, 1);
                    returnThis.artists.push(rows[i].artist);
                }
            }

            console.log(returnThis);
            res.send(JSON.stringify(returnThis));

        });

    });

});



app.get('/db/artists', function (req, res) {
    var sql = "SELECT DISTINCT artist FROM files ORDER BY artist  COLLATE NOCASE ASC;";

    var artists = {"artists":[]};

    db.all(sql, function(err, rows) {

        var returnArray = [];
        for (var i = 0; i < rows.length; i++) {
            if(rows[i].artist){
               // rows.splice(i, 1);
               artists.artists.push(rows[i].artist);
            }
        }

        console.log(JSON.stringify(artists));
        res.send(JSON.stringify(artists));
    });
});

app.post('/db/artists-albums', function (req, res) {
    var sql = "SELECT DISTINCT album FROM files WHERE artist = ? ORDER BY album  COLLATE NOCASE ASC;";

    var searchTerm = req.body.artist ;

    var albums = {"albums":[]};

    // TODO: Make a list of all songs without null albums and add them to the response
    db.all(sql, searchTerm, function(err, rows) {
        console.log(rows);

        var returnArray = [];
        for (var i = 0; i < rows.length; i++) {
            if(rows[i].album){
               // rows.splice(i, 1);
               albums.albums.push(rows[i].album);

            }
        }

        console.log(JSON.stringify(albums));

        res.send(JSON.stringify(albums));
    });
});



app.get('/db/albums', function (req, res) {
    var sql = "SELECT DISTINCT album FROM files ORDER BY album  COLLATE NOCASE ASC;";

    var albums = {"albums":[]};


    db.all(sql, function(err, rows) {

        var returnArray = [];
        for (var i = 0; i < rows.length; i++) {
            if(rows[i].album){
               // rows.splice(i, 1);
               albums.albums.push(rows[i].album);

            }
        }

        console.log(JSON.stringify(albums));
        res.send(JSON.stringify(albums));
    });
});

app.post('/db/album-songs', function (req, res) {
  var sql = "SELECT * FROM files WHERE album = ? ORDER BY filename  COLLATE NOCASE ASC;";
  var searchTerm = req.body.album ;

  db.all(sql, searchTerm, function(err, rows) {
    console.log(rows);
    res.send(JSON.stringify(rows));
  });
});


// GET DB Status
app.get('/db/status', function(req, res){
    var returnObject = {};

    var sql = 'SELECT Count(*) FROM files';

    db.get(sql, function(err, row){
        var fileCountDB = row.namesCount; // TODO: Is this correct???

        returnObject.locked = scanLock;
        returnObject.totalFileCount = fileCount;
        returnObject.dbFileCount = fileCountDB; 

        res.json(returnObject);
    });


});




// TODO: Add individual song
// app.get('/db/add-songs', function(req, res){
//     // deseralize json array
//     // Add all files
// });



var server = app.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);  
});