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
      return callback(true);
    }

    fileCollection = filesdb.getCollection("files");
    if (fileCollection === null) {
      // first time run so add and configure collection with some arbitrary options
      fileCollection = filesdb.addCollection("files");
    }

    callback(false);
  });
}

function saveDB(cb) {
  filesdb.saveDatabase(err => {
    if (err) {
      console.error("error : " + err);
    } else {
      console.log(JSON.stringify({msg: 'database saved', loadDB: true}));
    }
    if(cb) {
      cb();
    }
  });
}

exports.savedb = function (callback) {
  saveDB(callback);
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
  return new Promise((resolve, reject) => {
    while (arrayOfSongs.length > 0) {
      const song = arrayOfSongs.pop();

      fileCollection.insert({
        "title": song.title ? String(song.title) : null,
        "artist": song.artist ? String(song.artist) : null,
        "year": song.year ? song.year : null,
        "album": song.album ? String(song.album) : null,
        "filepath": song.filePath,
        "format": song.format,
        "track": song.track.no ? song.track.no : null,
        "disk": song.disk.no ? song.disk.no : null,
        "modified": song.modified,
        "hash": song.hash,
        "aaFile": song.aaFile ? song.aaFile : null,
        "vpath": vpath,
        "ts": Math.floor(Date.now() / 1000)
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
