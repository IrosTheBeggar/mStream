const archiver = require('archiver');
const path = require('path');
const winston = require('winston');
const vpath = require('../util/vpath');

exports.setup = (mstream) => {
  mstream.get('/api/v1/download/zip', (req, res) => {
    let fileArray;
    if (req.allowedFiles) {
      fileArray = req.allowedFiles;
    } else {
      // TODO: 
      return res.status(500).json({ error: err.message });
    }

    download(req, res, fileArray);
  });

  mstream.post('/api/v1/download/zip', (req, res) => {
    let fileArray;
    if (req.allowedFiles) {
      fileArray = allowedFiles;
    } else {
      fileArray = JSON.parse(req.body.fileArray);
    }
    download(req, res, fileArray);
  });


  function download(req, res, fileArray) {
    const archive = archiver('zip');

    archive.on('error', err => {
      winston.error(`Download Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    });

    res.attachment(`mstream-playlist.zip`);

    //streaming magic
    archive.pipe(res);

    for (let i in fileArray) {
      // TODO:  Confirm each item in posted data is a real file
      const pathInfo = vpath.getVPathInfo(fileArray[i], req.user);
      if (!pathInfo) { continue; }

      archive.file(pathInfo.fullPath, { name: path.basename(fileArray[i]) });
    }

    archive.finalize();
  }
}
