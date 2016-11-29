#!/usr/bin/env node

// This is designed to run as it's own process
// It takes in a json array
// {
//    "username":"lol",
//    "userDir":"/path/to/dir",
//    "dbType":"sqlite",
//    "dbSettings":{}
// }
const metadata = require('musicmetadata');
const fs = require('fs');  // File System
const fe = require('path');
const crypto = require('crypto');
const fe = require('path');


try{
  if(fe.extname(process.argv[process.argv.length-1]) == '.json'  &&  fs.statSync(process.argv[process.argv.length-1]).isFile()){
    var loadJson = JSON.parse(fs.readFileSync(args[args.length-1], 'utf8'));
  }else{
    console.log('Bad input');
    process.exit();
  }
}catch(error){
  console.log('JSON file does not appear to exist');
  process.exit();
}

// TODO: Check JSON for nencessary info


// TODO: Call Function


// 2.0
  // Get all files from DB
  // Hash file.  If file and hash are found in array, then skip
  // Seperate into new files and files that need to be updated
    // Send these arrays to functions in database-default-X.js


var arrayOfSongs; // Holds songs for DB to process // TODO: Move out of global scope
var arrayOfScannedFiles = []; // Holds files for from recursive scan

var parseFilesGenerator;  // This Generator is used in two places.  Should it be seperated?
// var scanDirLock = false;

//TODO: Pull in correct module

const dbRead = require('./modules/db-write/database-default-'+loadJson.dbType+'.js');
if(loadJson.dbType == 'sqlite'){
  dbRead.setup(loadJson.dbSettings.path); // TODO: Pass this in
}

function rescanAllDirectoriesWrapper(){
  // if(scanDirLock === true){
  //   // TODO: If scanlock == true, aleart user to try again once scanning is done
  //   // TODO: Enable Button
  //   return;
  // }

  // scanDirLock = true;
  // TODO: Disable Button

  parseFilesGenerator = rescanAllDirectories(dir);
  parseFilesGenerator.next();
}



function *rescanAllDirectories(directoryToScan){

  // Scan the directory for new, modified, and deleted files
  var filesToProcess = yield rescanDirectory(directoryToScan);

  // Process all new files
  while(filesToProcess.newFiles.length > 0) {
    // TODO: Break into chuncks and send to dbRead
    yield parseFile(filesToProcess.newFiles.pop());
  }

  // process all updated files
  while(filesToProcess.updatedFiles.length > 0) {
    // TODO: Break into chuncks and send to dbRead
    yield hashOneUpdatedSong(filesToProcess.updatedFiles.pop());
  }

  // Re-enable scanning
  // scanDirLock = false;
}



function rescanDirectory(dir){

  // Get all files from DB
  // TODO: Move This
  dbRead.getUserFiles(user, function(rows){

    // Scan through files
    var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
    recursiveScan(dir, fileTypesArray);

    var latestFileList = arrayOfScannedFiles;
    arrayOfScannedFiles = [];



    var dbFileList = [];
    var dbFileListTimestamp = [];

    for(var s of rows){
      console.log(s);
      dbFileList.push(s.path);

      dbFileListTimestamp.push(s.path + '::' + s.file_modified_date);
    }

    console.log(dbFileList);
    console.log(dbFileListTimestamp);



    var arrayOfUpdatedSongsToProcess = [];
    var arrayOfSongsToProcess = [];
    var deletedFiles = []; // TODO: Global variable ???
    var checkForModifications = [];



    var latestFileListSet = new Set(latestFileList);
    var dbFileListSet = new Set(dbFileList);
    var dbFileListTimestampSet = new Set(dbFileListTimestamp);


    // Get deleted files
    dbFileList.filter(function(x) {
      if( latestFileListSet.has(x) ){

      }else{
        // It's deleted ( i think)
        deletedFiles.push(x);
      }
    });

    console.log('DELETED FILES');
    console.log(deletedFiles);


    // Get new files
    latestFileList.filter(function(x) {

      console.log(x);

      if(dbFileListSet.has(x)){
        checkForModifications.push(x + "::" + fs.statSync(x).mtime.getTime()  );
        console.log('yes');

      }else{
        // New files
        arrayOfSongsToProcess.push(x);
        console.log('no');

      }
    });


    console.log('NEW FILES');
    console.log(arrayOfSongsToProcess);

    // loop through checkForModifications
      // Append timestamp to all path strings
      // Compare dbFileList clone with path strings appended
    checkForModifications.filter(function(x) {
      if(dbFileListTimestampSet.has(x)){

      }else{
         // File x  has been updated
         var filePath = x.split("::")[0];
         arrayOfUpdatedSongsToProcess.push(filePath);
      }
    });

    console.log('POTENTIALLY UPDATED SONGS');
    console.log(arrayOfUpdatedSongsToProcess);



    // TODO: Handle deleted files
    // We need to prompt users to see if they want to delete files on the server side
    // We can store a default behaviour

    returnArray = {
      "newFiles":arrayOfSongsToProcess,
      "updatedFiles":arrayOfUpdatedSongsToProcess,
      "deletedFiles":deletedFiles
    };
    parseFilesGenerator.next(returnArray);
  });

}



function parseFile(thisSong){
  var filestat = fs.statSync(thisSong);
  if(!filestat.isFile()){
    // TODO: Something is fucky, log it
    parseFilesGenerator.next();
    return;
  }

  // Stores all data that needs to be added to DB
  var songInfo;

  // TODO: Hash the file here and add the hash to the DB
  var hash = crypto.createHash('sha256');
  hash.setEncoding('hex');

  var readableStream = fs.createReadStream(thisSong);
  var parser = metadata(readableStream, function (err, songInfo) {
    if(err){
      // TODO: Do something
    }
    songInfo = thisSong;
    songInfo.filesize = filestat.size;
    songInfo.created = filestat.birthtime.getTime();
    songInfo.modified = ilestat.mtime.getTime();
    songInfo.filePath = thisSong;
    songInfo.format = getFileType(thisSong);



    readableStream.on('end', function () {
   	  hash.end();
      readableStream.close();

      songInfo.hash = String(hash.read());
      arrayOfSongs.push(songInfo);

      // if there are more than 100 entries, or if it's the last song
      if(arrayOfSongs.length > 99){
        //TODO: Need to move this function
        insertEntries();
      }

      // For the generator
      parseFilesGenerator.next();
    });


  });
  readableStream.pipe(hash);
}

function getFileType(filename){
  return filename.split(".").pop();
}

function recursiveScan(dir, fileTypesArray){
  var files = fs.readdirSync( dir );


  // loop through files
  for (var i=0; i < files.length; i++) {
    // var filePath = dir + files[i];
    var filePath = fe.join(dir,  files[i]);
    // console.log(filePath);
    var stat = fs.statSync(filePath);


    if(stat.isDirectory()){
      recursiveScan(filePath, fileTypesArray);
    }else{
      var extension = getFileType(files[i]);

      // Make sure this is in our list of allowed files
      if (fileTypesArray.indexOf(extension) > -1 ) {
        arrayOfScannedFiles.push(filePath);
      }
    }
  }
}

// TODO:
function insertEntries(){
  dbRead.sendUserFiles();
}
