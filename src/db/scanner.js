const metadata = require('music-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const Joi = require('joi');
const Jimp = require('jimp');

const axios = require('axios').create({
  httpsAgent: new (require('https')).Agent({  
    rejectUnauthorized: false
  })
});

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
  port: Joi.number().port().required(),
  token: Joi.string().required(),
  pause: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  isHttps: Joi.boolean().required(),
  compressImage: Joi.boolean().required(),
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

async function insertEntries(song) {
  const data = {
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
  };

  if (song.genre) { data.genre = song.genre };

  await axios({
    method: 'POST',
    url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/add-file`,
    headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
    responseType: 'json',
    data: data
  });
}

run();
async function run() {
  try {
    await recursiveScan(loadJson.directory);

    await axios({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/finish-scan`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId
      }
    });
  }catch (err) {
    console.error('Scan Failed');
    console.error(err.stack)
  }
}

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
      try {
        // Make sure this is in our list of allowed files
        if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
          continue;
        }

        const dbFileInfo = await axios({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/get-file`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: {
            filepath: path.relative(loadJson.directory, filepath),
            vpath: loadJson.vpath,
            modTime: stat.mtime.getTime(),
            scanId: loadJson.scanId
          }
        });

        if (Object.entries(dbFileInfo.data).length === 0) {
          const songInfo = await parseFile(filepath, stat.mtime.getTime());
          await insertEntries(songInfo);
        }
      } catch (err) {
        // console.log(err)
        console.error(`Warning: failed to add file ${filepath} to database: ${err.message}`);
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
    try {
      const hash = crypto.createHash('md5').setEncoding('hex');
      const fileStream = fs.createReadStream(filepath);

      fileStream.on('error', (err) => {
        reject(err);
      });
  
      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        resolve(hash.read());
      });
  
      fileStream.pipe(hash);
    }catch(err) {
      reject(err);
    }
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // picture is stored in song metadata
  if (songInfo.picture && songInfo.picture[0]) {
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(songInfo.picture[0].data.toString('utf-8')).digest('hex');
    songInfo.aaFile = picHashString + '.' + mime.extension(songInfo.picture[0].format);
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
      originalFileBuffer = songInfo.picture[0].data;
    }
  } else {
    originalFileBuffer = await checkDirectoryForAlbumArt(songInfo);
  }

  if (originalFileBuffer) {
    await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }

  const img = await Jimp.read(buff);
  await img.scaleToFit(256, 256).write(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await img.scaleToFit(92, 92).write(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
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
  let newFileFlag = false;

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
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;

  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split(".").pop();
}