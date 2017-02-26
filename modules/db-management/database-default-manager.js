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

const dbRead = require('../db-write/database-default-'+loadJson.dbSettings.type+'.js');
if(loadJson.dbSettings.type == 'sqlite'){
  dbRead.setup(loadJson.dbSettings.dbPath);
}


const parseFilesGenerator = rescanAllDirectories(loadJson.userDir);
parseFilesGenerator.next();

var globalCurrentFileList = {};

var listOfFilesToParse = [];
var listOfFilesToDelete = [];



function *rescanAllDirectories(directoryToScan){
  // Scan the directory for new, modified, and deleted files
  yield pullFromDB();

  // Loop through current files
  recursiveScan(directoryToScan);

  console.log(listOfFilesToParse);


  for (var i=0; i < listOfFilesToDelete.length; i++) {
    yield deleteFile(listOfFilesToDelete[i]);
  }

  for (var i=0; i < listOfFilesToParse.length; i++) {
    console.log(i);
    yield parseFile(listOfFilesToParse[i]);
  }

  // Anything left in globalCurrentFileList at this point has been deleted.  Remove these from the database
  // TODO: delete files

  // Exit
  process.exit(0);
}

function pullFromDB(){
  dbRead.getUserFiles(loadJson, function(rows){

    for(var s of rows){
      globalCurrentFileList[s.path] = s;
    }

    parseFilesGenerator.next();
  });
}



function recursiveScan(dir, fileTypesArray){
  var files = fs.readdirSync( dir );

  // loop through files
  for (var i=0; i < files.length; i++) {
    var filepath = fe.join(dir,  files[i]);
    try{
      var stat = fs.statSync(filepath);
    }catch(error){
      // Bad file, ignore and continue
      continue;
    }

    if(stat.isDirectory()){
      recursiveScan(filepath);
    }else{
      // Make sure this is in our list of allowed files
      var extension = getFileType(files[i]);
      var fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];

      if (fileTypesArray.indexOf(extension) === -1 ) {
        continue;
      }
      console.log(filepath);


      // Check if in globalCurrentFileList
      if (!(filepath in globalCurrentFileList)){
        // TODO: if Not parse new file, add it to DB, and continue
        listOfFilesToParse.push(filepath);
        // yield parseFile(filepath);
        continue;
      }

      // check the file_modified_date
      if(stat.mtime.getTime() !== globalCurrentFileList[filepath].file_modified_date){
        listOfFilesToParse.push(filepath);
        listOfFilesToDelete.push(filepath);


        // TODO: If they are not the same, parse and update
        // yield deleteFile();
        // yield parseFile(filepath);
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[filepath];
    }
  }
}



function parseFile(thisSong){
  console.log(thisSong);
  var filestat = fs.statSync(thisSong);
  console.log(filestat);
  if(!filestat.isFile()){
    // TODO: Something is fucky, log it
    console.log('BAD FILE');
    parseFilesGenerator.next();
    return;
  }

  // Stores all data that needs to be added to DB
  var songInfo;



  var readableStream = fs.createReadStream(thisSong);
  var parser = metadata(readableStream, function (err, thisMetadata) {
    readableStream.close();

    if(err){
      // TODO: Do something
    }

    songInfo = thisMetadata;
    songInfo.filesize = filestat.size;
    songInfo.created = filestat.birthtime.getTime();
    songInfo.modified = filestat.mtime.getTime();
    songInfo.filePath = thisSong;
    songInfo.format = getFileType(thisSong);


    // TODO: Hash the file here and add the hash to the DB
    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', function () {
   	  hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      console.log(songInfo);

      dbRead.insertEntries([songInfo], loadJson.username, function(){
        parseFilesGenerator.next();
      });
    });

    readableStream2.pipe(hash);

  });
}

function deleteFile(filepath){
  dbRead.deleteFile(filepath, loadJson.username, function(){
    // Re-add entry
    parseFilesGenerator.next();
  });
}

function getFileType(filename){
  return filename.split(".").pop();
}
