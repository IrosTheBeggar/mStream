#!/usr/bin/env node
"use strict";

const express = require('express');
const mstream = express();
const fs = require('fs');  // File System
const fe = require('path');
const bodyParser = require('body-parser');
const archiver = require('archiver');  // Zip Compression
const os = require('os');
const crypto = require('crypto');
const slash = require('slash');
const uuidV4 = require('uuid/v4');

// Get the server config
const program = require('./modules/configure-json-file.js').setup(process.argv, __dirname);
if(program.error){
  console.log(program.error);
  process.exit();
}

// Magic Middleware Things
mstream.use(bodyParser.json()); // support json encoded bodies
mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

// Setup WebApp
if(program.userinterface){
  mstream.use( express.static(fe.join(__dirname, program.userinterface) ));

  // Serve the webapp
  mstream.get('/', function (req, res) {
  	res.sendFile(  fe.join(program.userinterface, 'mstream.html'), { root: __dirname });
  });
}


// Print the local network IP
console.log('Access mStream locally: http://localhost:' + program.port);
console.log('Access mStream on your local network: http://' + require('my-local-ip')() + ':' + program.port);


// Handle Port Forwarding
// TODO: Switch between uPNP and nat-pmp
if(program.tunnel){
  const tunnel = require('./modules/auto-port-forwarding.js').setup(program.tunnel, program.port);
}


// Login functionality
if(program.users){
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
    // If the given secret is a filepath
    secret = fs.readFileSync(program.secret, 'utf8');
  }else if(program.secret){
    // Otherwise just use secret as is
    secret = String(program.secret);
  }else{
    // If no secret was given, generate one
    require('crypto').randomBytes(48, function(err, buffer) {
      secret = buffer.toString('hex');
    });
  }


  // TODO: Add New user functionality
    // Check for root user and password
    // Add credentials to user array

  // TODO: Need a way to store and use already hashed passwords


  // TODO: password change function
  mstream.post('/change-password-request', function (req, res) {
    // Get email address from request
      // validate email against user array
    // Generate change password token
    // Invalidate all other change password tokens
    // Email the user the token

  	res.sendFile( 'COMING SOON!' );
  });

  mstream.post('/change-password', function (req, res){
    // Check token
    // Get new password
    // Hash password and update user array

    res.sendFile( 'COMING SOON!' );
  });


  // Create the user array
  // var Users = {};

  var Users = program.users;
  for (let username in Users) {
    let permissionsMap = {};

    generateSaltedPassword(username, Users[username]["password"]);

    if(Users[username].guestTo){
      // DO NOTHING!
    }else if ( !(Users[username].musicDir  in permissionsMap) ){
      // Generate unique vPath if necessary
      // Th best way is to store the vPath in the JSON file
      if(!Users[username].vPath){
        Users[username].vPath = uuidV4();
      }

      // Add to permissionsMap
      permissionsMap[Users[username].musicDir] = Users[username].vPath;

      // Add dir to express
      mstream.use( '/' + Users[username].vPath + '/' , express.static( Users[username].musicDir   ));
    }else{
      Users[username].vPath = permissionsMap[Users[username].musicDir];
    }

  }


  function generateSaltedPassword(username, password){
    bcrypt.genSalt(10, function(err, salt) {
      bcrypt.hash(password, salt, function(err, hash) {
        // Store hash in your password DB.
        Users[username]['password'] = hash;
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
      user['username'] = username;

      // return the information including token as JSON
      var sendThis = {
        success: true,
        message: 'Welcome To mStream',
        vPath: user.vPath,
        token: jwt.sign(user, secret) // Make the token
      };

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
      // TODO: Modify this based on parameters set in json file
      if(decoded.guestTo && forbiddenFunctions.indexOf(req.path) != -1){
        return res.redirect('/guest-access-denied');
      }

      // Set user request data
      req.user = decoded;
      //
      if(decoded.guestTo){
        req.user.username = req.user.guestTo;
        // TODO: We should probably set the vPath elsewhere
        req.user.vPath = Users[req.user.guestTo].vPath;
        req.user.musicDir = Users[req.user.guestTo].musicDir;

      }
      next();
    });
  });

  // TODO:  Middleware that prevents users from accessing another users files
  // TODO: Strip all password info out
}else{

  // Dummy data
  mstream.use(function(req, res, next) {
    req.user = {
      username:"mstream-user",
      musicDir:process.cwd()
    };
    next();
  });

  mstream.use( '/' , express.static( process.cwd() ));
}




// Test function
// Used to determine the user has a working login token
mstream.get('/ping', function(req, res){
  // TODO: Guest status
  res.json({
    vPath: req.user.vPath,
    guest: false
  });
});



// parse directories
mstream.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // TODO: Make sure path is a sub-path of the user's music dir
  var path = fe.join(req.user.musicDir, req.body.dir);
  // Make sure it's a directory
  if(!fs.statSync( path).isDirectory()){
    res.status(500).json({ error: 'Not a directory' });
    return;
  }

  // Will only show these files.  Prevents people from snooping around
  // TODO: Move to global vairable
  const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
  var fileTypesArray;
  if(req.body.filetypes){
    fileTypesArray = JSON.parse(req.body.filetypes);
  }else{
    fileTypesArray = masterFileTypesArray;
  }


  // get directory contents
  var files = fs.readdirSync( path);

  // loop through files
  for (let i=0; i < files.length; i++) {

    try{
      var stat = fs.statSync(fe.join(path, files[i]));
    }catch(error){
      // Bad file, ignore and continue
      // TODO: Log This
      continue;
    }

    // Handle Directories
  	if(stat.isDirectory()){
  		directories.push({
        type:"directory",
        name:files[i]
      });
  	}else{ // Handle Files
      var extension = getFileType(files[i]);
      if (fileTypesArray.indexOf(extension) > -1 && masterFileTypesArray.indexOf(extension) > -1) {
        filesArray.push({
          type:extension,
          name:files[i]
        });
      }
    }
  }

  var returnPath = slash( fe.relative(req.user.musicDir, path) );
  if(returnPath.slice(-1) !== '/'){
    returnPath += '/';
  }

  // Send back combined list of directories and mp3s
  res.send(
    JSON.stringify({ path:returnPath, contents:filesArray.concat(directories)})
  );
});



function getFileType(filename){
  return filename.split(".").pop();
}


// Download a zip file of music
mstream.post('/download',  function (req, res){
  var archive = archiver('zip');

  archive.on('error', function(err) {
    console.log(err.message);
    res.status(500).send('{error: '+err.message+'}');
  });

  archive.on('end', function() {
    // TODO: add logging
  });

  //set the archive name
  // TODO: Rename this
  res.attachment('zipped-playlist.zip');

  //streaming magic
  archive.pipe(res);

  // Get the POSTed files
  var fileArray = JSON.parse(req.body.fileArray);

  ////////////////////////////////////////////////////////////
  // TODO:  Confirm each item in posted data is a real file //
  ////////////////////////////////////////////////////////////

  for(var i in fileArray) {
    var fileString = fileArray[i];
    archive.file(fe.normalize( fileString), { name: fe.basename(fileString) });
  }

  archive.finalize();
});



// ============================================================================

// // New Way
// // TODO: We need to pull this from the program var
var dbSettings = program.database_plugin;
const mstreamDB = require('./modules/db-management/database-master.js');
mstreamDB.setup(mstream, program);

// ============================================================================


// TODO: Add individual song
mstream.get('/db/add-songs', function(req, res){
  res.send('Coming Soon!');
});

// TODO: Get Album Art calls
mstream.post( '/get-album-art', function(req, res){
  // Get filepath from post
  // Check if album art is in DB
    // Return If So
  // Pull album art from file stream
  // ??? Lookup album art via 3rd party ???

  res.send('Coming Soon!');
});


// Start the server!
// TODO: Check if port is in use befoe firing up server
const server = mstream.listen(program.port, function () {});
