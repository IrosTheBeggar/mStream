#!/usr/bin/env node

var express = require('express');
var app = express();
var fs = require('fs');
var fe = require('path');
var bodyParser = require('body-parser');


var defaultdir = 'audiofiles/';
var startdir = startdir;

// Get starting directory from command line arguments
if(process.argv[2]){
  startdir = process.argv[2];
  // TODO: apply '/' to directory if it's not there
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
app.use( '/' + defaultdir , express.static( process.cwd() + '/' + startdir));
//app.use( '/' + 'dogs' , express.static( process.cwd() + '/' + startdir));  // Using a static name works well enough
// app.use( '/' + startdir , express.static( startdir));  // This also works

app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

// Handle ports
var port = 3000;
if(process.argv[3]){
  // TODO: Make sure argument is a legal port number
  port = process.argv[3];
}
console.log('Access mStream locally: http://localhost:' + port);



// Auto tunnel to the external world
if(process.argv[4] == 'tunnel'){
  var natpmp = require('nat-pmp');
  var netroute = require('netroute');
  var gateway = netroute.getGateway();
  var client = new natpmp.Client(gateway);
  client.portMapping({ public: port, private: port }, function (err, info) {
    if (err) throw err;
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


// TODO: Print the local IP


// Serve the webapp
app.get('/index', function (req, res) {
	res.sendFile('public/index.html', { root: __dirname }); 

  // TODO:send user directly to a directory
  // Check that directory exists
  if(req.query.path && fs.statSync(req.query.path).isDirectory()){
    // Make a javascript frontend vairable with this directory
    startdir += req.query.path;
  }

  // res.render( 'index.html');  // Might be able to pass in variables this way
});


// Returns the starting directory
app.get('/startdir', function (req, res){
   res.send(startdir);
});

app.post('/dirparser', function (req, res) {
  var directories = [];
  var filesArray = [];

  var path =  req.body.dir;


  // Make sure directory exits
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
app.get('/saveplaylist', function (req, res){

});

app.get('/loadplaylist', function (req, res){

});


var server = app.listen(port, function () {
  // var host = server.address().address;
  // var port = server.address().port;
  // console.log('Example app listening at http://%s:%s', host, port);  
});