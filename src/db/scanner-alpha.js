const metadata = require('music-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const loki = require('lokijs');
const Joi = require('joi');

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
  scanId: Joi.string().required(),
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
const filesdb = new loki(loadJson.dbPath);
let fileCollection;

let saveCounter = 0;
function insertEntries(song) {
  return new Promise((resolve, reject) => {
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
      "vpath": loadJson.vpath,
      "ts": Math.floor(Date.now() / 1000),
      "sID": loadJson.scanId,
      "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null
    });

    saveCounter++;
    if (saveCounter === loadJson.saveInterval) {
      saveCounter = 0;
      filesdb.saveDatabase(err => {
        if (err) {
          console.error('DB save error:');
          console.error(err);
        } else {
          console.log(JSON.stringify({msg: 'database saved', loadDB: true}));
        }
        resolve();
      });
    } else{
      resolve();
    }
  });
}

filesdb.loadDatabase({}, async err => {
  if (err) {
    console.error(`Failed to load DB`);
    console.log(err);
    process.exit(1);
  }

  fileCollection = filesdb.getCollection("files");
  if (fileCollection === null) {
    // first time run so add collection
    fileCollection = filesdb.addCollection("files");
  }

  await recursiveScan(loadJson.directory);

  // clear out old files
  fileCollection.findAndRemove({ '$and': [
    { 'vpath': { '$eq': loadJson.vpath } },
    { 'sID': { '$ne': loadJson.scanId } }
  ]});

  filesdb.saveDatabase(err => {
    if (err) {
      console.error('DB save error:');
      console.error(err);
    } 

    console.log('finished scan');
    process.exit(0);
  });
});

async function recursiveScan(dir) {
  try {
    var files = fs.readdirSync(dir);
  } catch (err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(dir, file);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      // Make sure this is in our list of allowed files
      if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
        continue;
      }

      // pull from DB
      const dbFileInfo = fileCollection.findOne({ '$and': [
        { 'filepath': { '$eq': path.relative(loadJson.directory, filepath) } },
        { 'vpath': { '$eq': loadJson.vpath } }
      ]});

      if (!dbFileInfo) {
        try {
          const songInfo = await parseFile(filepath, stat.mtime.getTime());
          await insertEntries(songInfo);
        } catch(err) {
          console.log(err)
          console.error(`Warning: failed to add file ${filepath} to database: ${err.message}`);
        }
      } else if (stat.mtime.getTime() !== dbFileInfo.modified) {
        try {
          // parse file
          const songInfo = await parseFile(filepath, stat.mtime.getTime());
          // delete old entry
          fileCollection.findAndRemove({ '$and': [
            { 'filepath': { '$eq': path.relative(loadJson.directory, filepath) } },
            { 'vpath': { '$eq': loadJson.vpath } }
          ]});
          // put in new entry
          await insertEntries(songInfo);

          // TODO: update users db
          
        } catch(err) {
          console.error(`Warning: failed to add file ${thisSong} to database: ${err.message}`);
        }
      } else {
        dbFileInfo.sID = loadJson.scanId;
        fileCollection.update(dbFileInfo);
      }

      // pause
      if (loadJson.pause) { await timeout(loadJson.pause); }
    }
  }
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function parseFile(thisSong, modified) {
  let songInfo;
  try {
    songInfo = (await metadata.parseFile(thisSong, { skipCovers: loadJson.skipImg })).common;
  } catch (err) {
    console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
    songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, thisSong);
  songInfo.format = getFileType(thisSong);
  songInfo.hash = await calculateHash(thisSong);
  await getAlbumArt(songInfo);

  return songInfo;
}

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5').setEncoding('hex');
    const fileStream = fs.createReadStream(filepath);

    fileStream.on('end', () => {
      hash.end();
      fileStream.close();
      resolve(hash.read());
    });

    fileStream.pipe(crypto.createHash('md5').setEncoding('hex'));
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  // picture is stored in song metadata
  if (songInfo.picture && songInfo.picture[0]) {
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(songInfo.picture[0].data.toString('utf-8')).digest('hex');
    songInfo.aaFile = picHashString + '.' + mime.extension(songInfo.picture[0].format);
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
    }
  } else {
    await checkDirectoryForAlbumArt(songInfo);
  }
}

const mapOfDirectoryAlbumArt = {};
async function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  // album art has already been found
  if (mapOfDirectoryAlbumArt[directory]) {
    return songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
  }

  // directory was already scanned and nothing was found
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  const imageArray = [];
  try {
    var files = fs.readdirSync(directory);
  } catch (err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(directory, file);
    try {
      var stat = fs.statSync(filepath);
    } catch (error) {
      // Bad file, ignore and continue
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (["png", "jpg"].indexOf(getFileType(file)) === -1) {
      continue;
    }

    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    return mapOfDirectoryAlbumArt[directory] = false;
  }

  let imageBuffer;
  let picFormat;

  // Search for a named file
  for (var i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png') {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
      picFormat = getFileType(imageArray[i]);
      break;
    }
  }
  
  // default to first file if none are named
  if (!imageBuffer) {
    imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
    picFormat = getFileType(imageArray[0]);
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer.toString('utf8')).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;
  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;
}

function getFileType(filename) {
  return filename.split(".").pop();
}