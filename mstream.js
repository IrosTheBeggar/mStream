#!/usr/bin/env node


var express = require('express');
var app = express();
var fs = require('fs');
var fe = require('path');
var bodyParser = require('body-parser');

var defaultdir = 'audiofiles/'
var startdir = startdir;
// Get starting directory from command line arguments
if(process.argv[2]){
  startdir = process.argv[2];
  console.log(startdir);

}
console.log(__dirname + '/public');
console.log(process.cwd());

// TODO: We might be able to remove this
startdir =  fe.normalize(startdir);
console.log('startdir: ' + startdir);

// Static files
app.use( express.static(__dirname + '/public'));
app.use( '/' + defaultdir , express.static( process.cwd() + '/' + startdir));
//app.use( '/' + 'dogs' , express.static( process.cwd() + '/' + startdir));  // Using a static name works well enough
// app.use( '/' + startdir , express.static( startdir));  // This also works

app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

app.set('view engine', 'jade'); // TODO: We might be able to remove this



// Serve the webapp
app.get('/index', function (req, res) {
	res.sendFile('public/index.html', { root: __dirname }); // This way deff works
  // TODO:send user directly to a directory

  // Check that directory exists
  if(req.query.path && fs.statSync(req.query.path).isDirectory()){
    console.log('yo');
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
  // get directory contents
  var files = fs.readdirSync( startdir + path);
  console.log(files);

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

  res.send(returnJSON);

});



var server = app.listen(3000, function () {
  var host = server.address().address;
  var port = server.address().port;

  // Pass in folder via command line argument

  console.log('Example app listening at http://%s:%s', host, port);  
});