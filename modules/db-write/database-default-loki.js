// These functions will take in JSON arrays of song data and then save that dat to the DB
const loki = require('lokijs');
var filesdb;
var fileCollection;

var saveCounter = 0;
var saveInterval = 500;

exports.setup = function (dbPath, sI, callback) {
  filesdb = new loki(dbPath);
  if (sI > 100) {
    saveInterval = sI;
  }

  filesdb.loadDatabase({}, err => {
    if (err) {
      console.error("error : " + err);
    }

    fileCollection = filesdb.getCollection("files");
    if (fileCollection === null) {
      // first time run so add and configure collection with some arbitrary options
      fileCollection = filesdb.addCollection("files");
    }

    callback()
  });
}

function saveDB(cb) {
  filesdb.saveDatabase(err => {
    if (err) {
      console.error("error : " + err);
    } else {
      process.stdout.write(JSON.stringify({msg: 'database saved', loadDB: true}));
    }
    if(cb) {
      cb();
    }
  });
}

exports.savedb = function (callback) {
  saveDB(callback)
}

exports.getVPathFiles = function (vpath, callback) {
  const results = fileCollection.find({ vpath: vpath });
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
  return new Promise((resolve, reject) => {
    while (arrayOfSongs.length > 0) {
      const song = arrayOfSongs.pop();

      fileCollection.insert({
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
      });

      saveCounter++;
      if (saveCounter === saveInterval) {
        saveCounter = 0;
        saveDB();
      }
    }

    resolve();
  });
}

exports.deleteFile = function (path, callback) {
  fileCollection.findAndRemove({ 'filepath': { '$eq': path } });
  callback();
}
