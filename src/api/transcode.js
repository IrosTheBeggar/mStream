const path = require("path");
const ffbinaries = require("ffbinaries");
const ffmpeg = require("fluent-ffmpeg");
const winston = require('winston');
const vpath = require('../util/vpath');
const config = require('../state/config');
const { Readable } = require('stream');

const platform = ffbinaries.detectPlatform();

const codecMap = {
  'mp3': { codec: 'libmp3lame', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus', contentType: 'audio/ogg' },
  'aac': { codec: 'aac', contentType: 'audio/aac' }
};

function initHeaders(res, audioTypeId, contentLength) {
  const contentType = codecMap[audioTypeId].contentType;
  return res.header({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Content-Length': contentLength
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

const transCache = {};
function ffmpegIt(pathInfo) {
  return ffmpeg(pathInfo.fullPath)
    .noVideo()
    .format(config.program.transcode.defaultCodec)
    .audioCodec(codecMap[config.program.transcode.defaultCodec].codec)
    .audioBitrate(config.program.transcode.defaultBitrate)
    .on('end', () => {
      winston.info('FFmpeg: file has been converted successfully');
    })
    .on('error', err => {
      winston.error('Transcoding Error!', { stack: err });
      winston.error(pathInfo.fullPath);
    });
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

      // check cache
      if (transCache[`${pathInfo.fullPath}|${config.program.transcode.defaultBitrate}|${config.program.transcode.defaultCodec}`]) {
        const t = transCache[`${pathInfo.fullPath}|${config.program.transcode.defaultBitrate}|${config.program.transcode.defaultCodec}`].deref();
        if (t!== undefined) {
          initHeaders(res, config.program.transcode.defaultCodec, t.contentLength);
          Readable.from(t.bufs).pipe(res);
          return;
        }
      }

      if (config.program.transcode.algorithm === 'stream') {
        return ffmpegIt(pathInfo).pipe(res);
      }

      const bufs = [];
      let contentLength = 0;
      const ffstream = ffmpegIt(pathInfo).pipe();

      ffstream.on('data', (chunk) => {
        bufs.push(chunk);
        contentLength += chunk.length;
      });
      
      ffstream.on('end', (chunk) => {
        // const contentLength = bufs.reduce((sum, buf) => {
        //   return sum + buf.length;
        // }, 0);
        initHeaders(res, config.program.transcode.defaultCodec, contentLength);

        transCache[`${pathInfo.fullPath}|${config.program.transcode.defaultBitrate}|${config.program.transcode.defaultCodec}`] = new WeakRef({
          contentLength, bufs
        });
        Readable.from(bufs).pipe(res);
      });

    // } else if (req.method === 'HEAD') {
    //   // The HEAD request should return the same headers as the GET request, but not the body
    //   initHeaders(res, config.program.transcode.defaultCodec, pathInfo.fullPath).sendStatus(200);
    } else {
      res.sendStatus(405); // Method not allowed
    }
  });
};
