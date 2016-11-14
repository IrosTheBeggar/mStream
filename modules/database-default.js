const metadata = require('musicmetadata'); // TODO: Look into replacing with taglib
const fs = require('graceful-fs');  // File System
const fe = require('path');
var dbCopy;


var arrayOfSongs = [];
var scanLock = false;
var yetAnotherArrayOfSongs = [];
var totalFileCount = 0;


function getFileType(filename){
  return filename.split(".").pop();
}

function parseFile(thisSong){
  var readableStream = fs.createReadStream(thisSong);
  var parser = metadata(readableStream, function (err, songInfo) {
    if(err){
      // TODO: Do something
    }


    // TODO: Hash the file here and add the hash to the DB

    console.log(songInfo);


    // Close the stream
    readableStream.close();


    songInfo.filePath = thisSong;
    songInfo.format = getFileType(thisSong);

    arrayOfSongs.push(songInfo);


    // if there are more than 100 entries, or if it's the last song
    if(arrayOfSongs.length > 99){
      insertEntries();
    }

    // For the generator
    parse.next();
  });
}

function *parseAllFiles(){

  // Loop through local items
  while(yetAnotherArrayOfSongs.length > 0) {
    var file = yetAnotherArrayOfSongs.pop();

    var resultX = yield parseFile(file);

  }

  insertEntries();
  scanLock = false;
}


var parse;



// Insert
function insertEntries(){
  var sql2 = "insert into items (title,artist,year,album,path,format, track, disk) values ";
  var sqlParser = [];

  while(arrayOfSongs.length > 0) {
    var song = arrayOfSongs.pop();

    // console.log(song);


    var songTitle = null;
    var songYear = null;
    var songAlbum = null;
    var artistString = null;

    if(song.artist && song.artist.length > 0){
      artistString = '';
      for (var i = 0; i < song.artist.length; i++) {
        artistString += song.artist[i] + ', ';
      }
      artistString = artistString.slice(0, -2);
    }
    if(song.title && song.title.length > 0){
      songTitle = song.title;
    }
    if(song.year && song.year.length > 0){
      songYear = song.year;
    }
    if(song.album && song.album.length > 0){
      songAlbum = song.album;
    }


    sql2 += "(?, ?, ?, ?, ?, ?, ?, ?), ";
    sqlParser.push(songTitle);
    sqlParser.push(artistString);
    sqlParser.push(songYear);
    sqlParser.push(songAlbum);
    sqlParser.push(song.filePath);
    sqlParser.push(song.format);
    sqlParser.push(song.track.no);
    sqlParser.push(song.disk.no);

  }

  sql2 = sql2.slice(0, -2);
  sql2 += ";";

  console.log(sql2);
  dbCopy.run(sql2, sqlParser);
}


//  Count all files
function countFiles (dir, fileTypesArray) {
  console.log('efwefwf');
  var files = fs.readdirSync( dir );
  console.log(files);


  for (var i=0; i < files.length; i++) {
    var filePath = fe.join(dir, files[i]);
    var stat = fs.statSync(filePath);
    console.log(filePath);


    if(stat.isDirectory()){
      console.log('qqq');

      countFiles(filePath , fileTypesArray);
    }else{
      console.log('www');

      var extension = getFileType(files[i]);

      if (fileTypesArray.indexOf(extension) > -1 ) {

        yetAnotherArrayOfSongs.push(filePath);
      }
    }
  }
}




exports.setup = function(mstream, program, rootDir, db){
  const rootDirCopy = rootDir;
  dbCopy = db;

  // scan and screate database
  mstream.get('/db/recursive-scan', function(req,res){

    console.log('xxx');

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


      console.log(rootDirCopy);

      countFiles(rootDirCopy, fileTypesArray);


      totalFileCount = yetAnotherArrayOfSongs.length;

      console.log(totalFileCount);


      dbCopy.serialize(function() {
        // These two queries will run sequentially.
        dbCopy.run("drop table if exists items;");
        dbCopy.run("CREATE TABLE items (  id INTEGER PRIMARY KEY AUTOINCREMENT,  title varchar DEFAULT NULL,  artist varchar DEFAULT NULL,  year int DEFAULT NULL,  album varchar  DEFAULT NULL,  path text, format varchar, track INTEGER, disk INTEGER);",  function() {
          // These queries will run in parallel and the second query will probably
          // fail because the table might not exist yet.
          console.log('TABLES CREATED');

          parse = parseAllFiles();
          parse.next();
        });
      });

    }catch(err){
      // Remove lock
      scanLock = false;

      // // Log error
      // res.status(500).send('{"error":"'+err+'"}');
      // console.log(err);
      return;
    }

    res.send("YA DID IT");

  });



  mstream.get('/db/status', function(req, res){
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
