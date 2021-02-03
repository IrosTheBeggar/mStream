const archiver = require('archiver');
const path = require('path');
const fs = require('fs').promises;
const winston = require('winston');
const vpath = require('../util/vpath');
const shared = require('../api/shared');
const m3u = require('../util/m3u');

exports.setup = (mstream) => {
  mstream.post('/api/v1/download/m3u', async (req, res) => {
    try {
      if (!req.body.path) { throw 'Validation Error' }

      const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
      if (!playlistPathInfo) { throw 'vpath lookup failed'; }
      const playlistParentDir = path.dirname(playlistPathInfo.fullPath);
      const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);
      
      const archive = archiver('zip');
      archive.on('error', function (err) {
        winston.error('Download Error', { stack: err });
        res.status(500).json({ error: err.message });
      });

      res.attachment(`${path.basename(req.body.path)}.zip`);
      archive.pipe(res);
      for (let song of songs) {
        const songPath = fe.join(playlistParentDir, song);
        archive.file(songPath, { name: fe.basename(song) });
      }
      archive.finalize();
    } catch (err) {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.post('/api/v1/download/directory', async (req, res) => {
    try {
      if (!req.body.directory) { throw 'Validation Error' }

      const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
      if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }

      if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw 'Not A Directory'; }

      const archive = archiver('zip');
      archive.on('error', (err) => {
        winston.error(`Download Error: ${err.message}`);
        res.status(500).json({ error: err.message });
      });

      res.attachment('mstream-directory.zip');

      // streaming magic
      archive.pipe(res);
      archive.directory(pathInfo.fullPath, false);
      archive.finalize();
    } catch (err) {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    }
  });

  mstream.get('/api/v1/download/zip', (req, res) => {
    let fileArray;
    if (req.sharedPlaylistId) {
      fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    } else {
      // TODO: 
      return res.status(500).json({ error: err.message });
    }

    download(req, res, fileArray);
  });

  mstream.post('/api/v1/download/zip', (req, res) => {
    let fileArray;
    if (req.sharedPlaylistId) {
      fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
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
