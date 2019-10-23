const ffbinaries = require("ffbinaries");
const fe = require("path");
const ffmpeg = require("fluent-ffmpeg");
const winston = require('winston');

const codecMap = {
  'mp3': 'libmp3lame',
  'opus': 'libopus',
  'aac': 'aac'
}

exports.setup = function (mstream, program) {
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

      mstream.get("/transcode/*", function (req, res) {
        const pathInfo = program.getVPathInfo(req.params[0]);
        if (pathInfo === false) {
          res.json({ "success": false });
          return;
        }

        ffmpeg(pathInfo.fullPath)
          .noVideo()
          .format(program.transcode.defaultCodec)
          .audioCodec(codecMap[program.transcode.defaultCodec])
          .audioBitrate(program.transcode.defaultBitrate)
          .on('end', function () {
            // console.log('file has been converted succesfully');
          })
          .on('error', function (err) {
            winston.error('Transcoding Error!');
            console.log(err);
          })
          // save to stream
          .pipe(res, { end: true });
      });
    }
  );
};
