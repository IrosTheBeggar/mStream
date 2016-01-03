#!/usr/bin/env node

var express = require('express');
var app = express();
var fs = require('fs');  // File System
var fe = require('path');
var bodyParser = require('body-parser');
var program = require('commander');  // Command Line Parser
var archiver = require('archiver');  // Zip Compression

var session = require('express-session'); // User Sessions

var os = require('os');

var startdir = '';


// TODO: Add user permissions
// Root: Access to everything 
// PlayOnly:  No downloads. No Saving
// PlaylistOnly: Only access a playlist given via GET request.  No Password required
// var User = function(){
//   var password = 'qwerty';

//   // Permissions: default is no permissions
//   this.downloads = true;
//   this.saving = false;
//   this.filebrowser = true;
// }

// var Root = function() {
//   var password = 'asdfgh';

//   this.downloads = true;
//   this.saving = true;
//   this.filebrowser = true;
// };


// app.use(session({
//   name: 'mstream-session-grade',
//   secret: 'tbg84e9q5gb8eiour8g3gnoiug0e4wu5ngiohn4',
//   saveUninitialized: true,
//   resave: true,
//   // store: new FileStore()
// }));


app.post('/login', function (req, res) {
  // var password =  req.body.password;
  // Match Password to array
});

// Setup Command Line Interface
program
  .version('1.7.0')
  .option('-p, --port <port>', 'Select Port', /^\d+$/i, 3000)
  .option('-t, --tunnel', 'Use nat-pmp to configure port fowarding')
  .option('-g, --gateip [gateip]', 'Manually set gateway IP for the tunnel option')
//  .option('-s, --ssl', 'Setup SSL')
  .parse(process.argv);

// Get starting directory from command line arguments
if(process.argv[2]){
  startdir = process.argv[2];
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


// Serve the webapp
app.get('/index', function (req, res) {
	res.sendFile('public/index.html', { root: __dirname }); 
});




// parse directories
app.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  // Make sure directory exits
  var path =  req.body.dir;
  if(!fs.statSync(startdir + path).isDirectory()){
    // TODO: Write an error output
    return;
  }

  // get directory contents
  var files = fs.readdirSync( startdir + path);

  // // loop through files
  for (var i=0; i < files.length; i++) {
    var tempDirArray = {};
    var tempFileArray = {};

  	var filePath = startdir + path + files[i];
  	var stat = fs.statSync(filePath);

    // Make list of directories
  	if(stat.isDirectory()){
		  tempDirArray["type"] = 'dir';
		  tempDirArray["link"] = files[i];

  		directories.push(tempDirArray);
  	}

    // Make list of mp3 files
  	if(files[i].substr(files[i].length - 3) === 'mp3'){
		  tempFileArray["type"] = 'mp3';
		  tempFileArray["filename"] = files[i];
		  tempFileArray["link"] = path + files[i];

  		filesArray.push(tempFileArray);
  	}
  }

  // Combine list of directories and mp3s
  var finalArray = filesArray.concat(directories);
  var returnJSON = JSON.stringify(finalArray);

  // Send back some JSON
  res.send(returnJSON);

});


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
    var tempObj = {name: tempName, file: contents[i] };


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


var server = app.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);  
});