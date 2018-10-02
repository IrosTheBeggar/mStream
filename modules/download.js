const archiver = require('archiver');
const fe = require('path');
require('./logger').init();
const winston = require('winston');

exports.setup = function (mstream, program) {
  mstream.post('/download', function (req, res) {
    const archive = archiver('zip');

    archive.on('error', function (err) {
      winston.error(`Download Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    });

    archive.on('end', function () {
      // TODO: add logging
    });

    // sets the archive name. TODO: Rename this
    res.attachment('zipped-playlist.zip');

    //streaming magic
    archive.pipe(res);

    // Get the POSTed files
    var fileArray;
    if (req.allowedFiles) {
      fileArray = allowedFiles;
    } else {
      fileArray = JSON.parse(req.body.fileArray);
    }

    for (var i in fileArray) {
      // TODO:  Confirm each item in posted data is a real file
      const pathInfo = program.getVPathInfo(fileArray[i]);
      if (pathInfo === false) {
        continue;
      }
      archive.file(pathInfo.fullPath, { name: fe.basename(fileArray[i]) });
    }

    archive.finalize();
  });
}
