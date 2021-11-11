const archiver = require('archiver');
const path = require('path');
const fs = require('fs').promises;
const winston = require('winston');
const vpath = require('../util/vpath');
const shared = require('../api/shared');
const m3u = require('../util/m3u');
const WebError = require('../util/web-error');

exports.setup = (mstream) => {
  mstream.post('/api/v1/download/m3u', async (req, res) => {
    if (!req.body.path) { throw new WebError('Validation Error', 403); }

    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
    if (!playlistPathInfo) { throw new Error('vpath lookup failed'); }
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
  });

  mstream.post('/api/v1/download/directory', async (req, res) => {
    if (!req.body.directory) { throw new WebError('Validation Error', 403); }

    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
    if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }

    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

    const archive = archiver('zip');
    archive.on('error', (err) => {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    });

    res.attachment('mstream-directory.zip');

    archive.pipe(res);
    archive.directory(pathInfo.fullPath, false);
    archive.finalize();
  });

  mstream.get('/api/v1/download/shared', (req, res) => {
    if (!req.sharedPlaylistId) { throw new WebError('Missing Playlist Id', 403); }
    const fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    download(req, res, fileArray);
  });

  mstream.post('/api/v1/download/zip', (req, res) => {
    const fileArray = JSON.parse(req.body.fileArray);
    download(req, res, fileArray);
  });

  async function download(req, res, fileArray) {
    const archive = archiver('zip');

    archive.on('error', err => {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    });

    res.attachment(`mstream-playlist.zip`);

    //streaming magic
    archive.pipe(res);

    for(const file of fileArray) {
      const pathInfo = vpath.getVPathInfo(file, req.user);
      if (!pathInfo) { continue; }
      try { await fs.access(pathInfo.fullPath)} catch (err) { return; }
      archive.file(pathInfo.fullPath, { name: path.basename(file) });
    }

    archive.finalize();
  }
}
