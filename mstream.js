"use strict";

exports.logit = function(msg){
  console.log(msg);
}

exports.addresses = {
  localhost: false,
  network: false,
  internet: false
}

exports.bootStatus = false;

exports.serveit = function (program, callback) {
  // TODO: Verify program variable

  const express = require('express');
  const mstream = express();
  const fs = require('fs');  // File System
  const fe = require('path');
  const bodyParser = require('body-parser');

  var server;

  if(program.ssl && program.ssl.cert && program.ssl.key){
    try{
      // TODO: Verify files are real
      server = require('https').createServer({
        key: fs.readFileSync(program.ssl.key),
        cert: fs.readFileSync( program.ssl.cert)
      });
    }catch(error){
      console.log('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }

  }else{
    console.log('SSL DISABLED');
    server = require('http').createServer();
  }

  // Magic Middleware Things
  mstream.use(bodyParser.json()); // support json encoded bodies
  mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

  // Setup WebApp
  if(program.userinterface){
    // Give access to public folder
    mstream.use( '/public',  express.static(fe.join(__dirname, program.userinterface) ));
    // Serve the webapp
    mstream.get('/', function (req, res) {
    	res.sendFile(  fe.join(program.userinterface, 'mstream.html'), { root: __dirname });
    });
    // Serve Shared Page
    mstream.all('/shared/playlist/*', function (req, res) {
      res.sendFile(  fe.join(program.userinterface, 'shared.html'), { root: __dirname });
    });
    // Serve Jukebox Page
    mstream.all('/remote', function (req, res) {
      res.sendFile(  fe.join(program.userinterface, 'remote.html'), { root: __dirname });
    });
  }
  // Setup Album Art
  if(!program.albumArtDir){
    program.albumArtDir = fe.join(__dirname, 'image-cache');
  }
  // Move to after login systm
  mstream.use( '/album-art',  express.static(program.albumArtDir ));


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
  // Shared
  const sharedModule = require('./modules/shared.js');
  sharedModule.setupBeforeSecurity(mstream, program);

  // Login functionality
  program.auth = false;
  if(program.users){
    require('./modules/login.js').setup(mstream, program, express);
    program.auth = true;
  }else{
    // Store the vPath incase any of the plugins need it
    program.vPath = 'music-vpath';

    program.users= {
      "mstream-user":{
        musicDir: program.musicDir,
        vPath: program.vPath,
        username: "mstream-user"
      }
    }
    // Fill in the necessary data
    mstream.use(function(req, res, next) {
      req.user = {
        username:"mstream-user",
        musicDir:program.musicDir,
        vPath: program.vPath
      };
      next();
    });

    mstream.use( '/' + program.vPath + '/' , express.static( program.musicDir ));
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
    res.status(500).json( {error: 'Coming Soon'} );
  });


  // mstream.post( '/scrape-user-info', function(req, res){
  //   // The idea behind this is to hav a function that dumps a JSON of all relevant user info
  //     // UUIDs
  //     // Password hashes
  //     // Jukebox client IDs
  //     // DB settings
  //     // All info in the initilization ini
  //
  //   // A higher level program can use this information to spin up an identical server
  //   // That way high bandwith users can be spun onto their own processes
  // });


  // Start the server!
  // TODO: Check if port is in use before firing up server
  server.on('request', mstream);
  server.listen(program.port, function () {
    exports.bootStatus = true;

    let protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';

    exports.addresses.local = protocol + '://localhost:' + program.port;
    exports.logit('Access mStream locally: ' + exports.addresses.local);

    require('internal-ip').v4().then(ip => {
      exports.addresses.network = protocol + '://' +  ip + ':' + program.port;
      exports.logit('Access mStream on your local network: ' + exports.addresses.network);
    });

    // Handle Port Forwarding
    if(program.tunnel){
      try{
        require('./modules/auto-port-forwarding.js').setup(program, function(status){
          if(status === true){
            require('public-ip').v4().then(ip => {
              // console.log('Access mStream on the internet: '+protocol+'://' + ip + ':' + program.port);
              exports.addresses.internet = protocol + '://' + ip + ':' + program.port;
              exports.logit('Access mStream on your local network:the internet: ' + exports.addresses.internet);
            });
          }else{
            console.log('Port Forwarding Failed');
            exports.logit('Port Forwarding Failed.  The server is runnig but you will have to configure your own port forwarding');
          }
        });
      }catch(err){
        console.log('Port Forwarding Failed');
        exports.logit('Port Forwarding Failed.  The server is runnig but you will have to configure your own port forwarding');
      }
    }
  });

}
