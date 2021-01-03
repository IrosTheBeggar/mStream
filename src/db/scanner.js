const metadata = require('music-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const loki = require('lokijs');
const Joi = require('joi');

// Parse input JSON
try {
  var loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  vpath: Joi.string().required(),
  directory: Joi.string().required(),
  dbPath: Joi.string().required(),
  pause: Joi.number().required(),
  saveInterval: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required()
});

const { error, value } = schema.validate(loadJson);
if (error) {
  console.error(`Invalid JSON Input`);
  console.log(error);
  process.exit(1);
}

// Setup DB
var filesdb = new loki(loadJson.dbPath);
var fileCollection;
let parseFilesGenerator;

filesdb.loadDatabase({}, err => {
  if (err) {
    console.error(`Failed to load DB`);
    console.log(err);
    process.exit(1);
  }

  fileCollection = filesdb.getCollection("files");
  if (fileCollection === null) {
    // first time run so add and configure collection with some arbitrary options
    fileCollection = filesdb.addCollection("files");
  }

  parseFilesGenerator = scanDirectory(loadJson.directory);
  parseFilesGenerator.next();
});

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

var saveCounter = 0;
function insertEntries(arrayOfSongs, vpath) {
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
        "ts": Math.floor(Date.now() / 1000),
        "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null
      });

      saveCounter++;
      if (saveCounter === loadJson.saveInterval) {
        saveCounter = 0;
        saveDB();
      }
    }

    resolve();
  });
}

// Global Vars
const globalCurrentFileList = {};  // Map of file paths to metadata
const listOfFilesToParse = [];
const listOfFilesToDelete = [];
const mapOfDirectoryAlbumArt = {};

// Scan the directory for new, modified, and deleted files
function* scanDirectory(directoryToScan) {
  // Pull filelist from DB
  pullFromDB();
  // Loop through current files and compare them to the files pulled from the DB
  recursiveScan(directoryToScan);
  // Delete Files
  for (var i = 0; i < listOfFilesToDelete.length; i++) {
    deleteFile(listOfFilesToDelete[i]);
  }
  // Delete all remaining files
  for (var file in globalCurrentFileList) {
    deleteFile(file);
  }
  // Parse and add files to DB
  for (var i = 0; i < listOfFilesToParse.length; i++) {
    yield parseFile(path.join(loadJson.directory, listOfFilesToParse[i]));
  }

  yield saveDB(() => {
    parseFilesGenerator.next();
  });

  // Exit
  process.exit(0);
}

// Get all files form DB and add to globalCurrentFileList
function pullFromDB() {
  var results = fileCollection.find({ vpath: loadJson.vpath });
  if (!results) {
    results = [];
  }

  for (var s of results) {
    globalCurrentFileList[s.filepath] = s.modified;
  }
}

function recursiveScan(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return;
  }

  // loop through files
  for (var i = 0; i < files.length; i++) {
    const filepath = path.join(dir, files[i]);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      recursiveScan(filepath);
    } else {
      // Make sure this is in our list of allowed files
      if (!loadJson.supportedFiles[getFileType(files[i]).toLowerCase()]) {
        continue;
      }

      // Check if in globalCurrentFileList
      if (!(path.relative(loadJson.directory, filepath) in globalCurrentFileList)) {
        // if not parse new file, add it to DB, and continue
        listOfFilesToParse.push(path.relative(loadJson.directory, filepath)); // use relative to remove extra data
        continue;
      }

      // check the file_modified_date
      if (stat.mtime.getTime() !== globalCurrentFileList[path.relative(loadJson.directory, filepath)]) {
        listOfFilesToParse.push(path.relative(loadJson.directory, filepath));
        listOfFilesToDelete.push(path.relative(loadJson.directory, filepath));
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[path.relative(loadJson.directory, filepath)];
    }
  }
}

function parseFile(thisSong) {
  var fileStat = fs.statSync(thisSong);
  if (!fileStat.isFile()) {
    console.error(`Warning: failed to parse file ${thisSong}: Unknown Error`);
    parseFilesGenerator.next();
    return;
  }

  const opt = {};
  if(loadJson.skipImg) {
    opt.skipCovers = true;
  }

  // Parse the file for metadata and store it in the DB
  return metadata.parseFile(thisSong, opt).then(thisMetadata => {
    return thisMetadata.common;
  }).catch(err => {
    console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
    return {track: { no: null, of: null }, disk: { no: null, of: null }};
  }).then(songInfo => {
    songInfo.modified = fileStat.mtime.getTime();
    songInfo.filePath = path.relative(loadJson.directory, thisSong);
    songInfo.format = getFileType(thisSong);
    // Calculate unique DB ID
    return calculateHash(thisSong, songInfo);
  }).then(songInfo => {
    // Stores metadata of song in the database
    return insertEntries([songInfo], loadJson.vpath)
  }).then(() => {
    // Continue with next file
    if(loadJson.pause && loadJson.pause > 0) {
      setTimeout(() => { parseFilesGenerator.next(); }, loadJson.pause);
    } else {
      parseFilesGenerator.next();
    }
  }).catch(err => {
    console.error(`Warning: failed to add file ${thisSong} to database: ${err.message}`);
    if(loadJson.pause && loadJson.pause > 0) {
      setTimeout(() => { parseFilesGenerator.next(); }, loadJson.pause);
    } else {
      parseFilesGenerator.next();
    }
  });
}

function calculateHash(thisSong, songInfo) {
  return new Promise((resolve, reject) => {
    // Handle album art
    //  TODO: handle cases where multiple images in metadata
    var bufferString = false;
    var picFormat = false;

    // Album art is in metadata
    if (songInfo.picture && songInfo.picture[0]) {
      bufferString = songInfo.picture[0].data.toString('utf8');
      picFormat = mime.extension(songInfo.picture[0].format);
    }
    // Album art has been pulled from directory already
    else if (mapOfDirectoryAlbumArt.hasOwnProperty(path.dirname(thisSong)) && mapOfDirectoryAlbumArt[path.dirname(thisSong)] !== false) {
      songInfo.aaFile = mapOfDirectoryAlbumArt[path.dirname(thisSong)];
    }
    // Directory has not been scanned for album art yet
    else if (!mapOfDirectoryAlbumArt.hasOwnProperty(path.dirname(thisSong))) {
      var albumArt = checkDirectoryForAlbumArt(path.dirname(thisSong));
      if (albumArt) {
        songInfo.aaFile = albumArt;
      }
    }


    // Hash the file here and add the hash to the DB
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', () => {
      hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      if (bufferString) {
        // Generate unique name based off hash of album art and metadata
        const picHashString = crypto.createHash('md5').update(bufferString).digest('hex');
        songInfo.aaFile = picHashString + '.' + picFormat;
        // Check image-cache folder for filename and save if doesn't exist
        if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
          // Save file sync
          fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
        }
      }

      resolve(songInfo);
    });

    readableStream2.pipe(hash);
  });
}

function checkDirectoryForAlbumArt(directory) {
  if (loadJson.skipImg === true) {
    return false;
  }
  var files = fs.readdirSync(directory);
  var imageArray = [];

  // loop through files
  for (var i = 0; i < files.length; i++) {
    var filepath = path.join(directory, files[i]);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      continue;
    }

    // Make sure its jpg/png
    if (["png", "jpg"].indexOf(getFileType(files[i])) === -1) {
      continue;
    }
    imageArray.push(files[i]);
  }

  if (imageArray.length === 0) {
    mapOfDirectoryAlbumArt[directory] = false;
    return;
  }

  var imageBuffer = false;
  var picFormat = false;

  // Only one image, assume it's album art
  if (imageArray.length === 1) {
    imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
    picFormat = getFileType(imageArray[0]);
  }else {
    // If there are multiple images, choose the first one with name cover, album, folder, etc
    for (var i = 0; i < imageArray.length; i++) {
      const imgMod = imageArray[i].toLowerCase();
      if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png') {
        imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
        picFormat = getFileType(imageArray[i]);
        break;
      }
    }
  }

  // TODO: If none match, choose the largest ???

  if (!imageBuffer) {
    mapOfDirectoryAlbumArt[directory] = false;
    return;
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer.toString('utf8')).digest('hex');
  const aaFile = picHashString + '.' + picFormat;

  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, aaFile), imageBuffer);
  }

  mapOfDirectoryAlbumArt[directory] = aaFile;
  return aaFile;
}

function deleteFile(filepath) {
  fileCollection.findAndRemove({ '$and': [
    { 'filepath': { '$eq': filepath } },
    { 'vpath': { '$eq': loadJson.vpath } }
  ]});
}

function getFileType(filename) {
  return filename.split(".").pop();
}
