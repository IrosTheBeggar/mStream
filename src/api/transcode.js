const path = require("path");
const ffbinaries = require("ffbinaries");
const ffmpeg = require("fluent-ffmpeg");
const winston = require('winston');
const vpath = require('../util/vpath');
const config = require('../state/config');

const platform = ffbinaries.detectPlatform();

const codecMap = {
  'mp3': { codec: 'libmp3lame', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus', contentType: 'audio/ogg' },
  'aac': { codec: 'aac', contentType: 'audio/aac' }
};

function initHeaders(res, audioTypeId, audioPath) {
  const contentType = codecMap[audioTypeId].contentType;
  return res.header({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
//    'Content-Length': stat.size
  });
}

let lockInit = false;
let isDownloading = false;

function init() {
  return new Promise((resolve, reject) => {
    // if (lockInit === true) { resolve(); }
    if (isDownloading === true) { reject('Download In Progress'); }
    isDownloading = true;
    winston.info('Checking ffmpeg...');
    ffbinaries.downloadFiles(
      ["ffmpeg", "ffprobe"],
      { platform: platform, quiet: true, destination: config.program.transcode.ffmpegDirectory },
      (err, data) => {
        isDownloading = false;
        if (err) { return reject(err); }
  
        try {
          winston.info('FFmpeg OK!');
          const ffmpegPath = path.join(config.program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffmpeg", platform));
          const ffprobePath = path.join(config.program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffprobe", platform));
          ffmpeg.setFfmpegPath(ffmpegPath);
          ffmpeg.setFfprobePath(ffprobePath);
          lockInit = true;
          resolve();
        }catch (err) {
          reject(err);
        }
      }
    );
  });
}

exports.reset = () => {
  lockInit = false;
}

exports.isEnabled = () => {
  if (lockInit === true && config.program.transcode.enabled === true) {
    return true;
  }

  return false;
}

exports.isDownloaded = () => {
  return lockInit;
}

exports.downloadedFFmpeg = async () => {
  await init();
}

exports.setup = async mstream => {
  if (config.program.transcode.enabled === true) { 
    init().catch(err => {
      winston.error('Failed to download FFmpeg', { stack: err })
    });
  }

  mstream.all("/transcode/*", (req, res) => {
    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const pathInfo = vpath.getVPathInfo(req.params[0], req.user);
    if (!pathInfo) { return res.json({ "success": false }); }

    // Stream audio data
    if (req.method === 'GET') {

      initHeaders(res, config.program.transcode.defaultCodec, pathInfo.fullPath);

      ffmpeg(pathInfo.fullPath)
        .noVideo()
        .format(config.program.transcode.defaultCodec)
        .audioCodec(codecMap[config.program.transcode.defaultCodec].codec)
        .audioBitrate(config.program.transcode.defaultBitrate)
        .on('end', () => {
          // console.log('file has been converted successfully');
        })
        .on('error', err => {
          winston.error('Transcoding Error!', { stack: err });
        })
        // save to stream
        .pipe(res, { end: true });
    } else if (req.method === 'HEAD') {
      // The HEAD request should return the same headers as the GET request, but not the body
      initHeaders(res, config.program.transcode.defaultCodec, pathInfo.fullPath).sendStatus(200);
    } else {
      res.sendStatus(405); // Method not allowed
    }
  });
};
