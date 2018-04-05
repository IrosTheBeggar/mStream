const ffbinaries = require("ffbinaries");
const fe = require("path");
const ffmpeg = require("fluent-ffmpeg");

exports.setup = function (mstream, program) {
  var dest = fe.join(__dirname, "ffmpeg");
  var platform = ffbinaries.detectPlatform();

  ffbinaries.downloadFiles(
    ["ffmpeg", "ffprobe"],
    { platform: platform, quiet: true, destination: dest },
    function (err, data) {
      console.log("Downloading ffmpeg binary for win-64 to " + dest + ".");
      console.log("err", err);
      console.log("data", data);

      var ffmpegPath = fe.join(
        dest,
        ffbinaries.getBinaryFilename("ffmpeg", platform)
      );

      var ffprobePath = fe.join(
        dest,
        ffbinaries.getBinaryFilename("ffprobe", platform)
      );
      console.log(ffmpegPath);
      console.log(ffprobePath);

      ffmpeg.setFfmpegPath(ffmpegPath);
      ffmpeg.setFfprobePath(ffprobePath);

      mstream.get("/transcode/*", function (req, res) {
        let pathInfo = program.getVPathInfo(req.params[0]);
        if (pathInfo === false) {
          res.json({ "success": false });
          return;
        }

        ffmpeg(pathInfo.fullPath)
          .noVideo()
          .format('mp3')
          .audioBitrate('128k')
          .on('end', function () {
            console.log('file has been converted succesfully');
          })
          .on('error', function (err) {
            console.log(err)
            console.log('an error happened: ' + err.message);
          })
          // save to stream
          .pipe(res, { end: true });
      });
    }
  );
};
