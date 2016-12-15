#!/usr/bin/env node
"use strict";


// This is designed to run as it's own process
// It takes in a json array
//  {
//    "username":"lol",
//    "userDir":"/Users/psori/Desktop/Blockhead",
//    "dbSettings":{
//     "type":"sqlite",
//     "dbPath":"/Users/psori/Desktop/LATESTGREATEST.DB"
//   }
// }

const metadata = require('musicmetadata');
const fs = require('fs');
const fe = require('path');
const crypto = require('crypto');


try{
  var loadJson = JSON.parse(process.argv[process.argv.length-1], 'utf8');

}catch(error){
  console.log('Cannot parse JSON input');
  process.exit();
}


// TODO: Check JSON for nencessary info




// 2.0
  // Get all files from DB
  // Hash file.  If file and hash are found in array, then skip
  // Seperate into new files and files that need to be updated
    // Send these arrays to functions in database-default-X.js


var arrayOfSongs = []; // Holds songs for DB to process // TODO: Move out of global scope
var arrayOfScannedFiles = []; // Holds files for from recursive scan


// Pull in correct module
console.log(loadJson.dbSettings.type);
// TODO: Rename this var
const dbRead = require('../db-write/database-default-'+loadJson.dbSettings.type+'.js');
if(loadJson.dbSettings.type == 'sqlite'){
  dbRead.setup(loadJson.dbSettings.dbPath); // TODO: Pass this in
}


// New way to start it
const parseFilesGenerator = rescanAllDirectories(loadJson.userDir);
parseFilesGenerator.next();


function *rescanAllDirectories(directoryToScan){
  // Scan the directory for new, modified, and deleted files
  var filesToProcess = yield rescanDirectory(directoryToScan);

  // Process all new files
  if(filesToProcess.newFiles.length != 0){
    while(filesToProcess.newFiles.length > 0) {
      yield parseFile(filesToProcess.newFiles.pop());
    }
    // Finish inserting all new entries
    yield insertEntries(50, true);
  }


  // process all updated files
  while(filesToProcess.updatedFiles.length > 0) {
    // Handle Editted songs
    yield parseUpdatedSong(filesToProcess.updatedFiles.pop());
    yield insertEntries(50, true);
  }

  // TODO: Process deleted files
  while(filesToProcess.deletedFiles.length > 0) {
    // Handle Editted songs
    yield deleteFile(filesToProcess.deletedFiles.pop());
  }

  // Exit
  process.exit(0);
}

function rescanDirectory(dir){

  // Get all files from DB
  // TODO: Move This
  dbRead.getUserFiles(loadJson, function(rows){

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

    var returnArray = {
      "newFiles":arrayOfSongsToProcess,
      "updatedFiles":arrayOfUpdatedSongsToProcess,
      "deletedFiles":deletedFiles
    };
    parseFilesGenerator.next(returnArray);
  });

}

// TODO: Fix this
function parseUpdatedSong(filePath){
  // Check sha256 hash and confirm it has changed
  // Update file status in DB accordingly


  var fileStream = fs.createReadStream(filePath);

  var hash = crypto.createHash('sha256');
  hash.setEncoding('hex');


  fileStream.on('end', function () {
    hash.end();

    var hashIt = String(hash.read());

    // compare hashes
    //db.all("SELECT * FROM files WHERE path=? AND hash=?", [filePath, hashIt], function(err, rows){
    dbRead.getHashedEntry(hashIt, filePath, loadJson.username, function(rows){
      console.log(rows);
      // No match found, file needs to be updated
      if( !rows ||  rows.length === 0 ){
        // TODO: delete entry
        dbRead.deleteFile(filePath, loadJson.username, function(){
          // Re-add entry
          parseFile(filePath);
        });

      }else{
        parseFilesGenerator.next();

      }

   });
  });

  fileStream.pipe(hash);
}


function deleteFile(filepath){
  dbRead.deleteFile(filepath, loadJson.username, function(){
    // Re-add entry
    parseFilesGenerator.next();
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
  var parser = metadata(readableStream, function (err, thisMetadata) {
    if(err){
      // TODO: Do something
    }
    console.log(songInfo);
    console.log(filestat);

    songInfo = thisMetadata;
    songInfo.filesize = filestat.size;
    songInfo.created = filestat.birthtime.getTime();
    songInfo.modified = filestat.mtime.getTime();
    songInfo.filePath = thisSong;
    songInfo.format = getFileType(thisSong);



    readableStream.on('end', function () {
   	  hash.end();
      readableStream.close();

      songInfo.hash = String(hash.read());

      console.log('XXXXXXXXXXXXXXXxx');
      console.log(songInfo);

      arrayOfSongs.push(songInfo);

      // if there are more than 100 entries, or if it's the last song
      if(arrayOfSongs.length > 99){
        // Insert entries into DB
        insertEntries(99, false);
      }else{
        // For the generator
        parseFilesGenerator.next();
      }

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


function insertEntries(numberToInsert = 99, loopToEnd = false){
  var insertThese = [];

  while(insertThese.length != numberToInsert ){
    if(arrayOfSongs.length == 0){
      break;
    }
    insertThese.push(arrayOfSongs.pop());
  }

  dbRead.insertEntries(insertThese, loadJson.username, function(){
    // Recursivly run this function until all songs have been added
    if(loopToEnd && arrayOfSongs.length != 0){
      insertEntries(numberToInsert, true);
    }else{
      // For the generator
      parseFilesGenerator.next();
    }
  });
}
