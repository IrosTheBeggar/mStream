// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs');
var filesdb;
var fileCollection;

var saveCounter = 0;

// Add a collection to the database
// const fileCollection = filesdb.addCollection('files');

exports.setup = function(dbPath, callback){
  filesdb = new loki(dbPath);

  filesdb.loadDatabase({}, function(err) {
    if (err) {
      console.log("error : " + err);
    }
    else {
      // console.log("database loaded.");
    }

    fileCollection = filesdb.getCollection("files");
    if (fileCollection === null) {
      // first time run so add and configure collection with some arbitrary options
      fileCollection = filesdb.addCollection("files");
    }

    callback()
  });
}

exports.savedb = function(callback){
  filesdb.saveDatabase(function(err) {
    if (err) {
      console.log("error : " + err);
    }
    else {
      // console.log("database saved.");
    }
    callback()
  });
}

exports.getUserFiles = function(thisUser, callback){
  var results = fileCollection.find({ user: thisUser.username });
  if(!results){
     results = [];
  }
  callback(results);
}

/**
 * @param arrayOfSongs
 * @param username
 * @return Promise
 */
exports.insertEntries = function(arrayOfSongs, username){
  return new Promise(function(resolve, reject) {
    while(arrayOfSongs.length > 0) {
      var song = arrayOfSongs.pop();

      var doc = {
        "title": song.title,
        "artist": song.artist,
        "year": song.year,
        "artist": song.artist,
        "album": song.album,
        "filepath": song.filePath,
        "format": song.format,
        "track": song.track.no,
        "disk": song.disk.no,
        "filesize": song.filesize,
        "modified": song.modified,
        "created": song.created,
        "hash": song.hash,
        "albumArtFilename": song.albumArtFilename,
        "user": username,
      };
      fileCollection.insert(doc);

      saveCounter++;
      if(saveCounter === 100){
        saveCounter = 0;
        filesdb.saveDatabase(function(err) {
          if (err) {
            console.log("error : " + err);
          }
          else {
            console.log("database saved.");
          }
        });
      }
    }

    resolve();
  });
}


exports.deleteFile = function(path, user, callback){
  fileCollection.findAndRemove({'filePath': { '$eq' : path }});
  callback();
}
