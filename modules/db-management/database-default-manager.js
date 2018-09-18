// This is designed to run as it's own process
// It takes in a json array
//  {
//    "vpath":"metal",
//    "directory":"/path/to/metal/music",
//    "dbSettings":{
//      "dbPath":"/path/to/LATESTGREATEST.DB"
//    }
//    "pause": 500,
//    "saveInterval": 1000,
//    "skipImg":true
//    "albumArtDir": "/album/art/dir"
// }

// Parse input JSON
try {
  var loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (error) {
  console.error('Cannot parse JSON input');
  process.exit();
}

// TODO: Validate input
// TODO: Create image folder if it doesn't exist

// Libraries
const metadata = require('music-metadata');
const fs = require('fs');
const fe = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

// Only parse these file types
const fileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];

// Setup DB layer
// The DB functions are decoupled from this so they can easily be swapped out
const dbRead = require('../db-write/database-default-loki.js');

// Global Vars
const globalCurrentFileList = {};  // Map of file paths to metadata
const listOfFilesToParse = [];
const listOfFilesToDelete = [];
const mapOfDirectoryAlbumArt = {};

// Start the generator
const parseFilesGenerator = scanDirectory(loadJson.directory);
parseFilesGenerator.next();

// Scan the directory for new, modified, and deleted files
function* scanDirectory(directoryToScan) {
  // TODO: Kill thread if this fails to load
  yield dbRead.setup(loadJson.dbSettings.dbPath, loadJson.saveInterval, function () {
    parseFilesGenerator.next();
  });
  process.stdout.write(JSON.stringify({msg: `File scan started at ${Date.now()}`}));
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
    yield parseFile(listOfFilesToParse[i]);
  }

  yield dbRead.savedb(() => {
    parseFilesGenerator.next();
  });
  process.stdout.write(JSON.stringify({msg: `File scan successfully finished at ${Date.now()}`}));
  // Exit
  process.exit(0);
}

// Get all files form DB and add to globalCurrentFileList
function pullFromDB() {
  dbRead.getVPathFiles(loadJson.vpath, function (rows) {
    for (var s of rows) {
      globalCurrentFileList[s.filepath] = s;
    }
  });
}


function recursiveScan(dir) {
  const files = fs.readdirSync(dir);

  // loop through files
  for (var i = 0; i < files.length; i++) {
    const filepath = fe.join(dir, files[i]);
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
      if (fileTypesArray.indexOf(getFileType(files[i])) === -1) {
        continue;
      }

      // Check if in globalCurrentFileList
      if (!(filepath in globalCurrentFileList)) {
        // if not parse new file, add it to DB, and continue
        listOfFilesToParse.push(filepath);
        continue;
      }

      // check the file_modified_date
      if (stat.mtime.getTime() !== globalCurrentFileList[filepath].modified) {
        listOfFilesToParse.push(filepath);
        listOfFilesToDelete.push(filepath);
      }

      // Remove from globalCurrentFileList
      delete globalCurrentFileList[filepath];
    }
  }
}



function parseFile(thisSong) {
  var filestat = fs.statSync(thisSong);
  if (!filestat.isFile()) {
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
    thisMetadata.common.filesize = filestat.size;
    thisMetadata.common.created = filestat.birthtime.getTime();
    thisMetadata.common.modified = filestat.mtime.getTime();
    thisMetadata.common.filePath = thisSong;
    thisMetadata.common.format = getFileType(thisSong);
    return thisMetadata.common;
  }).then(songInfo => {
    // Calculate unique DB ID
    return calculateHash(thisSong, songInfo);
  }).then(songInfo => {
    // Stores metadata of song in the database
    return dbRead.insertEntries([songInfo], loadJson.vpath)
  }).then(() => {
    // Continue with next file
    parseFilesGenerator.next();
  }).catch(err => {
    // TODO: Put file in DB anyway
    console.error(`Warning: failed to parse file ${thisSong}: ${ err.message}`);
    parseFilesGenerator.next();
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
    else if (mapOfDirectoryAlbumArt.hasOwnProperty(fe.dirname(thisSong)) && mapOfDirectoryAlbumArt[fe.dirname(thisSong)] !== false) {
      songInfo.albumArtFilename = mapOfDirectoryAlbumArt[fe.dirname(thisSong)];
    }
    // Directory has not been scanned for album art yet
    else if (!mapOfDirectoryAlbumArt.hasOwnProperty(fe.dirname(thisSong))) {
      var albumArt = checkDirectoryForAlbumArt(fe.dirname(thisSong));
      if (albumArt) {
        songInfo.albumArtFilename = albumArt;
      }
    }


    // Hash the file here and add the hash to the DB
    var hash = crypto.createHash('sha256');
    hash.setEncoding('hex');
    var readableStream2 = fs.createReadStream(thisSong);

    readableStream2.on('end', () => {
      hash.end();
      readableStream2.close();

      songInfo.hash = String(hash.read());

      if (bufferString) {
        // Generate unique name based off hash of album art and metadata
        const picHashString = crypto.createHash('sha256').update(bufferString).digest('hex');
        songInfo.albumArtFilename = picHashString + '.' + picFormat;
        // Check image-cache folder for filename and save if doesn't exist
        if (!fs.existsSync(fe.join(loadJson.albumArtDir, songInfo.albumArtFilename))) {
          // Save file sync
          fs.writeFileSync(fe.join(loadJson.albumArtDir, songInfo.albumArtFilename), songInfo.picture[0].data);
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
    var filepath = fe.join(directory, files[i]);
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
    if (["png", "jpg"].indexOf(getFileType(files[i]) === -1)) {
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
    imageBuffer = fs.readFileSync(fe.join(directory, imageArray[0]));
    picFormat = getFileType(imageArray[0]);
  }

  // If there are multiple images, choose the first one with name cover, album, folder, etc
  for (var i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png') {
      imageBuffer = fs.readFileSync(fe.join(directory, imageArray[i]));
      picFormat = getFileType(imageArray[i]);
      break;
    }
  }

  // TODO: If none match, choose the largest ???

  if (!imageBuffer) {
    mapOfDirectoryAlbumArt[directory] = false;
    return;
  }

  const picHashString = crypto.createHash('sha256').update(imageBuffer.toString('utf8')).digest('hex');
  const albumArtFilename = picHashString + '.' + picFormat;

  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(fe.join(loadJson.albumArtDir, albumArtFilename))) {
    // Save file sync
    fs.writeFileSync(fe.join(loadJson.albumArtDir, albumArtFilename), imageBuffer);
  }

  mapOfDirectoryAlbumArt[directory] = albumArtFilename;
  return albumArtFilename;
}

function deleteFile(filepath) {
  dbRead.deleteFile(filepath, function () { });
}

function getFileType(filename) {
  return filename.split(".").pop();
}
