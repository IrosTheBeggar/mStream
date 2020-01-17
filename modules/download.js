const archiver = require('archiver');
const fe = require('path');
const winston = require('winston');

exports.setup = (mstream, program) => {
  mstream.post('/download', (req, res) => {
    const archive = archiver('zip');

    archive.on('error', err => {
      winston.error(`Download Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    });

    res.attachment(`mstream-playlist.zip`);

    //streaming magic
    archive.pipe(res);

    // Get the POSTed files
    let fileArray;
    if (req.allowedFiles) {
      fileArray = allowedFiles;
    } else {
      fileArray = JSON.parse(req.body.fileArray);
    }

    for (let i in fileArray) {
      // TODO:  Confirm each item in posted data is a real file
      const pathInfo = program.getVPathInfo(fileArray[i], req.user);
      if (!pathInfo) { continue; }

      archive.file(pathInfo.fullPath, { name: fe.basename(fileArray[i]) });
    }

    archive.finalize();
  });
}
