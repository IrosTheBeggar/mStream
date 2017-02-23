"use strict";

module.exports = function (program) {

// TODO: Verify program variable

const server = require('http').createServer();
const express = require('express');
const mstream = express();
const fs = require('fs');  // File System
const fe = require('path');
const bodyParser = require('body-parser');


// Magic Middleware Things
mstream.use(bodyParser.json()); // support json encoded bodies
mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

// Setup WebApp
if(program.userinterface){
  mstream.use( '/public',  express.static(fe.join(__dirname, program.userinterface) ));

  // Serve the webapp
  mstream.get('/', function (req, res) {
  	res.sendFile(  fe.join('public', 'mstream.html'), { root: __dirname });
  });
}


// Print the local network IP
console.log('Access mStream locally: http://localhost:' + program.port);
console.log('Access mStream on your local network: http://' + require('internal-ip').v4() + ':' + program.port);
// This would be ideal but it returns the wrong address on occasion
// require('dns').lookup(require('os').hostname(), function (err, add, fam) {
//   console.log('Access mStream on your local network: http://' + add + ':' + program.port);
// })


// Handle Port Forwarding
if(program.tunnel){
  const tunnel = require('./modules/auto-port-forwarding.js').setup(program.tunnel, program.port);
}


// TODO: Move this to the configure module
// Setup Secret for JWT
try{
  // IF user entered a filepath
  if(fs.statSync(program.secret).isFile()){
    program.secret = fs.readFileSync(program.secret, 'utf8');
  }
}catch(error){
  if(program.secret){
    // just use secret as is
    program.secret = String(program.secret);
  }else{
    // If no secret was given, generate one
    require('crypto').randomBytes(48, function(err, buffer) {
      program.secret = buffer.toString('hex');
    });
  }
}



// JukeBox
const jukebox = require('./modules/jukebox.js');
jukebox.setup2(mstream, server, program);
// Serve Jukebox Page
mstream.all('/remote', function (req, res) {
  res.sendFile(  fe.join('public', 'remote.html'), { root: __dirname });
});

// Shared
const sharedModule = require('./modules/shared.js');
sharedModule.setupBeforeSecurity(mstream, program);
// Serve the shared webapp
mstream.all('/shared/*', function (req, res) {
  res.sendFile(  fe.join('public', 'shared.html'), { root: __dirname });
});




// Login functionality
if(program.users){
  require('./modules/login.js').setup(mstream, program, express);
}else{
  // Dummy data
  mstream.use(function(req, res, next) {
    req.user = {
      username:"mstream-user",
      musicDir:program.musicDir
    };
    next();
  });

  mstream.use( '/' , express.static( program.musicDir ));
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





// Download Files Call
require('./modules/download.js').setup(mstream, program);

// File Explorer API Call
require('./modules/file-explorer.js').setup(mstream, program);

// Load database plugin system
require('./modules/db-management/database-master.js').setup(mstream, program);

// Finish setting up the jukebox and shared
jukebox.setup(mstream, server, program);
sharedModule.setupAfterSecurity(mstream, program);



// TODO: Add individual song
mstream.get('/db/add-songs', function(req, res){
  res.send('Coming Soon!');
});

// TODO: Get Album Art calls
mstream.post( '/get-album-art', function(req, res){
  res.send('Coming Soon!');
});

mstream.post( '/scrape-user-info', function(req, res){
  // The idea behind this is to hav a function that dumps a JSON of all relevant user info
    // UUIDs
    // Password hashes
    // Jukebox client IDs
    // DB settings
    // All info in the initilization ini

  // A higher level program can use this information to spin up an identical server
  // That way high bandwith users can be spun onto their own processes
});


// Start the server!
// TODO: Check if port is in use befoe firing up server
server.on('request', mstream);
server.listen(program.port, function () { });


}
