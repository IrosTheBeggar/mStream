import path from 'path';
import fs from 'fs/promises';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as shared from '../api/shared.js';
import * as m3u from '../util/m3u.js';
import WebError from '../util/web-error.js';
import { createZipForResponse, addDirectoryRecursive } from '../util/zip-stream.js';

export function setup(mstream) {
  mstream.post('/api/v1/download/m3u', (req, res) => {
    downloadM3U(req, res).catch(err  => {
      throw err;
    })
  });

  async function downloadM3U(req, res) {
    if (!req.body.path) { throw new WebError('Validation Error', 403); }
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
    const playlistParentDir = path.dirname(pathInfo.fullPath);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);

    const zipFile = createZipForResponse(
      res,
      `${path.basename(req.body.path)}.zip`,
      'Download Error',
    );

    for (const song of songs) {
      const songPath = path.resolve(playlistParentDir, song);
      // Verify resolved path stays within the library root
      if (!songPath.startsWith(path.resolve(pathInfo.basePath) + path.sep) && songPath !== path.resolve(pathInfo.basePath)) {
        winston.warn(`M3U entry escaped library root: ${song}`);
        continue;
      }
      zipFile.addFile(songPath, path.basename(song));
    }

    zipFile.addFile(pathInfo.fullPath, path.basename(pathInfo.fullPath));
    zipFile.end();
  }

  mstream.post('/api/v1/download/directory',  (req, res) => {
    downloadDir(req, res).catch(err => {
      throw err;
    })
  });

  async function downloadDir(req, res) {
    if (!req.body.directory) { throw new WebError('Validation Error', 403); }

    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

    const zipFile = createZipForResponse(res, 'mstream-directory.zip', 'Download Error');
    await addDirectoryRecursive(zipFile, pathInfo.fullPath);
    zipFile.end();
  }

  mstream.get('/api/v1/download/shared', (req, res) => {
    if (!req.sharedPlaylistId) { throw new WebError('Missing Playlist Id', 403); }
    const fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    download(req, res, fileArray).catch(err => {
      throw err;
    });
  });

  mstream.post('/api/v1/download/zip', (req, res) => {
    const fileArray = JSON.parse(req.body.fileArray);
    download(req, res, fileArray).catch(err => {
      throw err;
    });
  });

  async function download(req, res, fileArray) {
    const zipFile = createZipForResponse(res, 'mstream-playlist.zip', 'Download Error');

    for(const file of fileArray) {
      try {
        const pathInfo = vpath.getVPathInfo(file, req.user);
        await fs.access(pathInfo.fullPath);
        zipFile.addFile(pathInfo.fullPath, path.basename(file));
      } catch (err) {
        winston.warn(`Failed to access file ${file} for download, skipping.`);
        winston.warn(err);
        continue;
      }
    }

    zipFile.end();
  }
}
