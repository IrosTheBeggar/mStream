// This is designed to run as it's own process
// It takes in a json array
//  {
//    "username":"lol",
//    "userDir":"/Users/psori/Desktop/Blockhead",
//    "dbSettings":{
//     "type":"sqlite",
//     "dbPath":"/Users/psori/Desktop/LATESTGREATEST.DB"
//    }
//    "albumArtDir": "/album/art/dir"
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

console.log(loadJson);

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
  console.log(globalCurrentFileList);

  // Loop through current files
  recursiveScan(directoryToScan);
  //console.log(listOfFilesToParse);

  for (var i=0; i < listOfFilesToDelete.length; i++) {
    yield deleteFile(listOfFilesToDelete[i]);
  }

  for (var i=0; i < listOfFilesToParse.length; i++) {
    yield parseFile(listOfFilesToParse[i]);
  }


  // Exit
  process.exit(0);
}

function pullFromDB(){
  dbRead.getUserFiles(loadJson, function(rows){
    console.log(rows);

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

      // Check if in globalCurrentFileList
      if (!(filepath in globalCurrentFileList)){
        // if not parse new file, add it to DB, and continue
        listOfFilesToParse.push(filepath);
        // yield parseFile(filepath);
        continue;
      }

      // check the file_modified_date
      if(stat.mtime.getTime() !== globalCurrentFileList[filepath].file_modified_date){
        listOfFilesToParse.push(filepath);
        listOfFilesToDelete.push(filepath);
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[filepath];
    }
  }
}



function parseFile(thisSong){
  // console.log(thisSong);
  var filestat = fs.statSync(thisSong);
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


    // Handle album art
      //  TODO: handle cases where multiple images in metadata
    var bufferString = false;
    var picFormat = false;
    if(songInfo.picture[0]){
      bufferString = songInfo.picture[0].data.toString('utf8');
      picFormat = songInfo.picture[0].format;
      console.log(songInfo.picture);
    }else if(false){ // TODO: Check if there is album art in base folder

    }


    // Hash the file here and add the hash to the DB
    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', function () {
   	  hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      if(bufferString !== false){
        // Generate unique name based off hash of album art and metadata
        var picHashString = crypto.createHash('sha256').update(bufferString).digest('hex');
        songInfo.albumArtFilename = picHashString + '.' + picFormat;
        // Cehck image-cache folder for filename and save if doesn't exist
        if (!fs.existsSync(songInfo.albumArtFilename)) {
          // Save file sync
          fs.writeFileSync(fe.join(loadJson.albumArtDir, songInfo.albumArtFilename), songInfo.picture[0].data);
        }
      }

      //console.log(songInfo);
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
