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

  // This is a convenience function. It gets the vPath from any url string
  program.getVPathInfo = function(url){
    // remove leading slashes
    if(url.charAt(0) === '/'){
      url = url.substr(1);
    }

    var fileArray = url.split('/');
    var vpath = fileArray.shift();

    // Make sure the path exists
    if(!program.folders[vpath]){
      return false;
    }
    var baseDir = program.folders[vpath].root;
    var newPath = '';
    for(var dir of fileArray){
      if(dir === ''){
        continue;
      }
      newPath += dir + '/' ;
    }

    // TODO: There's gotta be a better way to construct the relative path
    if(newPath.charAt(newPath.length-1) ===  '/'){
      newPath = newPath.slice(0, - 1);
    }

    var fullpath = fe.join( baseDir, newPath)
    return {
      vpath: vpath,
      basePath: baseDir,
      relativePath: newPath,
      fullPath: fullpath
    };
  }

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
    program.users = {
      "mstream-user":{
        vpaths: [],
        username: "mstream-user",
        admin: true
      }
    }

    if(program['lastfm-user'] && program['lastfm-password']){
      program.users['mstream-user']['lastfm-user'] = program['lastfm-user']
      program.users['mstream-user']['lastfm-password'] = program['lastfm-password']
    }

    // Fill iin user vpaths
    for (var key in program.folders) {
      program.users['mstream-user'].vpaths.push(key);
    }

    // Fill in the necessary middleware
    mstream.use(function(req, res, next) {
      req.user = program.users['mstream-user'];
      next();
    });
  }

  // Setup all folders with express static
  for (var key in program.folders) {
    mstream.use( '/media/' + key + '/' , express.static(  program.folders[key].root  ));
  }

  // Used to determine the user has a working login token
  mstream.get('/ping', function(req, res){
    res.json({
      vpaths: req.user.vpaths,
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
  // mstream.get('/db/add-songs', function(req, res){
  //   res.status(500).json( {error: 'Coming Soon'} );
  // });

  // Scrobbler
  require('./modules/scrobbler.js').setup(mstream, program);

  // Start the server!
  // TODO: Check if port is in use before firing up server
  server.on('request', mstream);
  server.listen(program.port, function () {
    console.log('Donate to our Patreon: https://www.patreon.com/mstream')
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
