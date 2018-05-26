// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs');
var filesdb;
var fileCollection;

var saveCounter = 0;

// Add a collection to the database
// const fileCollection = filesdb.addCollection('files');

exports.setup = function (dbPath, callback) {
  filesdb = new loki(dbPath);

  filesdb.loadDatabase({}, function (err) {
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

exports.savedb = function (callback) {
  filesdb.saveDatabase(function (err) {
    if (err) {
      console.log("error : " + err);
    }
    else {
      // console.log("database saved.");
    }
    callback()
  });
}

exports.getVPathFiles = function (vpath, callback) {
  var results = fileCollection.find({ vpath: vpath });
  if (!results) {
    results = [];
  }
  callback(results);
}

/**
 * @param arrayOfSongs
 * @param vpath
 * @return Promise
 */
exports.insertEntries = function (arrayOfSongs, vpath) {
  return new Promise(function (resolve, reject) {
    while (arrayOfSongs.length > 0) {
      var song = arrayOfSongs.pop();

      var doc = {
        "title": String(song.title),
        "artist": String(song.artist),
        "year": song.year,
        "album": String(song.album),
        "filepath": song.filePath,
        "format": song.format,
        "track": song.track.no,
        "disk": song.disk.no,
        "filesize": song.filesize,
        "modified": song.modified,
        "created": song.created,
        "hash": song.hash,
        "albumArtFilename": song.albumArtFilename,
        "vpath": vpath,
        "rating": 0,
        "lastPlayed": 0
      };

      fileCollection.insert(doc);

      saveCounter++;
      if (saveCounter === 100) {
        saveCounter = 0;
        filesdb.saveDatabase(function (err) {
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


exports.deleteFile = function (path, callback) {
  fileCollection.findAndRemove({ 'filepath': { '$eq': path } });
  callback();
}
