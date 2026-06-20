import archiver from 'archiver';
import path from 'path';
import fs from 'fs/promises';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as shared from '../api/shared.js';
import * as m3u from '../util/m3u.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  // These handlers must be async and `await` the worker. In Express 5 a
  // rejected promise returned from the handler is forwarded to the error
  // middleware; the old `fn(req,res).catch(err => { throw err })` threw into
  // a promise nobody awaited, so a pre-stream error (validation, bad vpath,
  // not-a-directory) became an unhandled rejection and the client got a hung
  // connection with no status instead of a 4xx/5xx.
  mstream.post('/api/v1/download/m3u', async (req, res) => {
    await downloadM3U(req, res);
  });

  async function downloadM3U(req, res) {
    if (!req.body.path) { throw new WebError('Validation Error', 403); }
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
    const playlistParentDir = path.dirname(pathInfo.fullPath);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);

    const archive = archiver('zip');
    archive.on('error', function (err) {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`${path.basename(req.body.path)}.zip`);
    archive.pipe(res);
    for (const song of songs) {
      const songPath = path.resolve(playlistParentDir, song);
      // Verify resolved path stays within the library root
      if (!songPath.startsWith(path.resolve(pathInfo.basePath) + path.sep) && songPath !== path.resolve(pathInfo.basePath)) {
        winston.warn(`M3U entry escaped library root: ${song}`);
        continue;
      }
      archive.file(songPath, { name: path.basename(song) });
    }

    archive.file(pathInfo.fullPath, { name: path.basename(pathInfo.fullPath) });
    archive.finalize();
  }

  mstream.post('/api/v1/download/directory', async (req, res) => {
    await downloadDir(req, res);
  });

  async function downloadDir(req, res) {
    if (!req.body.directory) { throw new WebError('Validation Error', 403); }

    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new WebError('Not A Directory', 400); }

    const archive = archiver('zip');
    archive.on('error', (err) => {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: 'Download Error' });
    });

    res.attachment('mstream-directory.zip');

    archive.pipe(res);

    archive.directory(pathInfo.fullPath, false);
    archive.finalize();
  }

  mstream.get('/api/v1/download/shared', async (req, res) => {
    if (!req.sharedPlaylistId) { throw new WebError('Missing Playlist Id', 403); }
    const fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    await download(req, res, fileArray);
  });

  mstream.post('/api/v1/download/zip', async (req, res) => {
    const fileArray = JSON.parse(req.body.fileArray);
    await download(req, res, fileArray);
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
      try {
        const pathInfo = vpath.getVPathInfo(file, req.user);
        await fs.access(pathInfo.fullPath);
        archive.file(pathInfo.fullPath, { name: path.basename(file) });
      } catch (err) {
        winston.warn(`Failed to access file ${file} for download, skipping.`, { stack: err });
        continue;
      }
    }

    archive.finalize();
  }
}
