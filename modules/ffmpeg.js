const ffbinaries = require("ffbinaries");
const fe = require("path");
const ffmpeg = require("fluent-ffmpeg");
const winston = require('winston');

const codecMap = {
  'mp3': {codec: 'libmp3lame', contentType: 'audio/mpeg'},
  'opus': {codec: 'libopus', contentType: 'audio/ogg'},
  'aac': {codec: 'aac', contentType: 'audio/aac'}
};

function initHeaders(res, audioTypeId, audioPath) {
  const contentType = codecMap[audioTypeId].contentType;
  return res.header({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
//    'Content-Length': stat.size
  });
}

exports.setup = (mstream, program) => {
  const platform = ffbinaries.detectPlatform();

  winston.info('Checking ffmpeg...');
  ffbinaries.downloadFiles(
    ["ffmpeg", "ffprobe"],
    { platform: platform, quiet: true, destination: program.transcode.ffmpegDirectory },
    (err, data) => {
      if (err) {
        winston.error('Failed to download ffmpeg.  Transcoding is disabled.');
        winston.error(err);
        return;
      }
      winston.info('ffmpeg OK! Transcoding enabled');

      const ffmpegPath = fe.join(program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffmpeg", platform));
      const ffprobePath = fe.join(program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffprobe", platform));
      ffmpeg.setFfmpegPath(ffmpegPath);
      ffmpeg.setFfprobePath(ffprobePath);

      mstream.get("/transcode/*", (req, res) => {
        const pathInfo = program.getVPathInfo(req.params[0], req.user);
        if (!pathInfo) { return res.json({ "success": false }); }

        // Stream audio data
        if (req.method === 'GET') {

          initHeaders(res, program.transcode.defaultCodec, pathInfo.fullPath);

          ffmpeg(pathInfo.fullPath)
            .noVideo()
            .format(program.transcode.defaultCodec)
            .audioCodec(codecMap[program.transcode.defaultCodec].codec)
            .audioBitrate(program.transcode.defaultBitrate)
            .on('end', () => {
              // console.log('file has been converted successfully');
            })
            .on('error', err => {
              winston.error('Transcoding Error!');
              console.log(err);
            })
            // save to stream
            .pipe(res, { end: true });
        } else if (req.method === 'HEAD') {
          // The HEAD request should return the same headers as the GET request, but not the body
          initHeaders(res, program.transcode.defaultCodec, pathInfo.fullPath).sendStatus(200);
        } else {
          res.sendStatus(405); // Method not allowed
        }
      });
    }
  );
};
