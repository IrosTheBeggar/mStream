const metadata = require('musicmetadata');
const fs = require('graceful-fs');  // File System
const fe = require('path');
const crypto = require('crypto');

// var dbCopy;
//
//
// var arrayOfSongs = [];
// var scanLock = false;
// var yetAnotherArrayOfSongs = [];
// var totalFileCount = 0;
//



//TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO:

// Break this into two pieces

// This piece will contain all the functions that scan for files and parse meta data and hashFileBeets
  // These functions will return JSON arrays of song data

// The next piece will contain the all the functions that store data into the db
  // These functions will take in JSON arrays of song data and then save that dat to the DB
  // next piece name: /modules/db-write/database-default-[sqlite/mysql/loki].js

//TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO: TODO:





//TODO: Spawn new thread for processing files
// Handle users when processing files
// Hash files when processing
// Handle album art when processing files
// Use created/modified dates to handle updating DB


// function getFileType(filename){
//   return filename.split(".").pop();
// }
//
// function parseFile(thisSong){
//   var readableStream = fs.createReadStream(thisSong);
//   var parser = metadata(readableStream, function (err, songInfo) {
//     if(err){
//       // TODO: Do something
//     }
//
//
//     // TODO: Hash the file here and add the hash to the DB
//
//     console.log(songInfo);
//
//
//     // Close the stream
//     readableStream.close();
//
//
//     songInfo.filePath = thisSong;
//     songInfo.format = getFileType(thisSong);
//
//     arrayOfSongs.push(songInfo);
//
//
//     // if there are more than 100 entries, or if it's the last song
//     //TODO
//     if(arrayOfSongs.length > 99){
//       insertEntries();
//     }
//
//     // For the generator
//     parse.next();
//   });
// }
//
// function *parseAllFiles(){
//
//   // Loop through local items
//   while(yetAnotherArrayOfSongs.length > 0) {
//     var file = yetAnotherArrayOfSongs.pop();
//
//     var resultX = yield parseFile(file);
//
//   }
//
//   // TODO
//   insertEntries();
//   scanLock = false;
// }
//
//
// var parse;



// Insert
// TODO: Move this to db-write/database-default-X.js
// function insertEntries(){
//   var sql2 = "insert into items (title,artist,year,album,path,format, track, disk) values ";
//   var sqlParser = [];
//
//   while(arrayOfSongs.length > 0) {
//     var song = arrayOfSongs.pop();
//
//     // console.log(song);
//
//
//     var songTitle = null;
//     var songYear = null;
//     var songAlbum = null;
//     var artistString = null;
//
//     if(song.artist && song.artist.length > 0){
//       artistString = '';
//       for (var i = 0; i < song.artist.length; i++) {
//         artistString += song.artist[i] + ', ';
//       }
//       artistString = artistString.slice(0, -2);
//     }
//     if(song.title && song.title.length > 0){
//       songTitle = song.title;
//     }
//     if(song.year && song.year.length > 0){
//       songYear = song.year;
//     }
//     if(song.album && song.album.length > 0){
//       songAlbum = song.album;
//     }
//
//
//     sql2 += "(?, ?, ?, ?, ?, ?, ?, ?), ";
//     sqlParser.push(songTitle);
//     sqlParser.push(artistString);
//     sqlParser.push(songYear);
//     sqlParser.push(songAlbum);
//     sqlParser.push(song.filePath);
//     sqlParser.push(song.format);
//     sqlParser.push(song.track.no);
//     sqlParser.push(song.disk.no);
//
//   }
//
//   sql2 = sql2.slice(0, -2);
//   sql2 += ";";
//
//   console.log(sql2);
//   dbCopy.run(sql2, sqlParser);
// }

//
// //  Count all files
// function countFiles (dir, fileTypesArray) {
//   console.log('efwefwf');
//   var files = fs.readdirSync( dir );
//   console.log(files);
//
//
//   for (var i=0; i < files.length; i++) {
//     var filePath = fe.join(dir, files[i]);
//     var stat = fs.statSync(filePath);
//     console.log(filePath);
//
//
//     if(stat.isDirectory()){
//       console.log('qqq');
//
//       countFiles(filePath , fileTypesArray);
//     }else{
//       console.log('www');
//
//       var extension = getFileType(files[i]);
//
//       if (fileTypesArray.indexOf(extension) > -1 ) {
//
//         yetAnotherArrayOfSongs.push(filePath);
//       }
//     }
//   }
// }

//
// function runOnStart(){
//
//   // Loop through users
//     // Scan one at a time
//
//   // Check DB for the last addition timed
//
//   // Loop through users files
//
//   // Check for modification time
//     // if modification time is newer than the latest time, go to next step
//       // if file exists inthe db already, add it to modificationCheckArray
//       // if it doesn't exist, add it to newSongArray
//
// }



exports.setup = function(mstream, users, db){
  const rootDirCopy = rootDir;
  dbCopy = db;

  runOnStart();

  // scan and screate database
  mstream.get('/db/recursive-scan-mstream', function(req,res){

    // Check if this is already running
    if(scanLock === true){
      // Return error
      res.status(401).send('{"error":"Scan in progress"}');
      return;
    }

    try{
      // turn on scan lock
      scanLock = true;

      // Make sure directory exits
      var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];

      countFiles(rootDirCopy, fileTypesArray);
      totalFileCount = yetAnotherArrayOfSongs.length;

        // TODO: Move this
      // dbCopy.serialize(function() {
      //   // These two queries will run sequentially.
      //   dbCopy.run("drop table if exists items;");
      //   dbCopy.run("CREATE TABLE items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
      //     // These queries will run in parallel and the second query will probably
      //     // fail because the table might not exist yet.
      //     console.log('TABLES CREATED');
      //
      //     parse = parseAllFiles();
      //     parse.next();
      //   });
      // });

    }catch(err){
      // Remove lock
      scanLock = false;

      // TODO Log error
      // console.log(err);
      return;
    }

    res.send("YA DID IT");

  });



  mstream.get('/db/status-mstream', function(req, res){
    var returnObject = {};

    returnObject.locked = scanLock;


    if(scanLock){

      returnObject.totalFileCount = totalFileCount;
      returnObject.filesLeft = yetAnotherArrayOfSongs.length;

      res.json(returnObject);

    }else{
      var sql = 'SELECT Count(*) FROM items';

      dbCopy.get(sql, function(err, row){
        if(err){
          console.log(err.message);

          res.status(500).json({ error: err.message });
          return;
        }


        var fileCountDB = row['Count(*)']; // TODO: Is this correct???

        returnObject.totalFileCount = fileCountDB;
        res.json(returnObject);

      });
    }

  });

}




































// 2.0
  // Get all files from DB
  // Hash file.  If file and hash are found in array, then skip
  // Seperate into new files and files that need to be updated
    // Send these arrays to functions in database-default-X.js


var arrayOfSongs; // Holds songs for DB to process // TODO: Move out of global scope
var arrayOfScannedFiles = []; // Holds files for from recursive scan

var parseFilesGenerator;  // This Generator is used in two places.  Should it be seperated?
var scanDirLock = false;

//TODO: Pull in correct module
const dbRead = require('./modules/db-write/database-default-sqlite.js')

function rescanAllDirectoriesWrapper(){
  if(scanDirLock === true){
    // TODO: If scanlock == true, aleart user to try again once scanning is done
    // TODO: Enable Button
    return;
  }

  scanDirLock = true;
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
  scanDirLock = false;
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
