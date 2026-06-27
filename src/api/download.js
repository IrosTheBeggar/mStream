import { ZipArchive } from 'archiver';
import path from 'path';
import fs from 'fs/promises';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as shared from '../api/shared.js';
import * as m3u from '../util/m3u.js';
import * as config from '../state/config.js';
import { parseSizeToBytes } from '../util/parse-size.js';
import { joiValidate } from '../util/validation.js';
import Joi from 'joi';
import WebError from '../util/web-error.js';

// Configured cap on a bulk download's total uncompressed size, in bytes.
// 0 = unlimited (the default, and the fallback if the configured string is
// somehow unparseable). Read live so an admin change applies on the next
// request with no reboot.
function downloadLimitBytes() {
  return parseSizeToBytes(config.program.downloadSizeLimit) || 0;
}

// Sum the sizes of a list of absolute file paths. Files that can't be stat'd
// are skipped — they wouldn't be added to the archive either.
async function sumFileSizes(absPaths) {
  let total = 0;
  for (const p of absPaths) {
    try {
      const st = await fs.stat(p);
      if (st.isFile()) { total += st.size; }
    } catch { /* not statable → not archived → not counted */ }
  }
  return total;
}

// Recursively sum the sizes of every file under a directory.
async function sumDirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumDirSize(full);
    } else if (entry.isFile()) {
      try { total += (await fs.stat(full)).size; } catch { /* skip */ }
    }
  }
  return total;
}

function overLimit() {
  return new WebError(`Download exceeds the configured size limit (${config.program.downloadSizeLimit})`, 413);
}

// Size-gate a list of files BEFORE any archive bytes are streamed, so an
// over-limit request gets a clean 413 instead of a truncated zip. No-op (and
// no stat work) when the limit is unlimited.
async function enforceFileLimit(absPaths) {
  const limit = downloadLimitBytes();
  if (limit <= 0) { return; }
  if (await sumFileSizes(absPaths) > limit) { throw overLimit(); }
}

async function enforceDirLimit(dir) {
  const limit = downloadLimitBytes();
  if (limit <= 0) { return; }
  if (await sumDirSize(dir) > limit) { throw overLimit(); }
}

export function setup(mstream) {
  // These handlers must be async and `await` the worker. In Express 5 a
  // rejected promise returned from the handler is forwarded to the error
  // middleware; the old `fn(req,res).catch(err => { throw err })` threw into
  // a promise nobody awaited, so a pre-stream error (validation, bad vpath,
  // not-a-directory, over-size) became an unhandled rejection and the client
  // got a hung connection with no status instead of a 4xx/5xx.
  mstream.post('/api/v1/download/m3u', async (req, res) => {
    await downloadM3U(req, res);
  });

  async function downloadM3U(req, res) {
    joiValidate(Joi.object({ path: Joi.string().required() }), req.body);
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
    const playlistParentDir = path.dirname(pathInfo.fullPath);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);

    // Resolve the entries we'll actually archive (those that stay within the
    // library root), then size-gate before streaming.
    const songPaths = [];
    for (const song of songs) {
      const songPath = path.resolve(playlistParentDir, song);
      // Verify resolved path stays within the library root
      if (!songPath.startsWith(path.resolve(pathInfo.basePath) + path.sep) && songPath !== path.resolve(pathInfo.basePath)) {
        winston.warn(`M3U entry escaped library root: ${song}`);
        continue;
      }
      songPaths.push(songPath);
    }
    await enforceFileLimit([...songPaths, pathInfo.fullPath]);

    const archive = new ZipArchive();
    archive.on('error', function (err) {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`${path.basename(req.body.path)}.zip`);
    archive.pipe(res);
    for (const songPath of songPaths) {
      archive.file(songPath, { name: path.basename(songPath) });
    }
    archive.file(pathInfo.fullPath, { name: path.basename(pathInfo.fullPath) });
    archive.finalize();
  }

  mstream.post('/api/v1/download/directory', async (req, res) => {
    await downloadDir(req, res);
  });

  async function downloadDir(req, res) {
    joiValidate(Joi.object({ directory: Joi.string().required() }), req.body);

    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new WebError('Not A Directory', 400); }
    await enforceDirLimit(pathInfo.fullPath);

    const archive = new ZipArchive();
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
    // Resolve + access-check every requested file up front so we can size-gate
    // before streaming. Anything that fails resolution/access is skipped (it
    // wouldn't be archived anyway) and excluded from the size total.
    const entries = [];
    for (const file of fileArray) {
      try {
        const pathInfo = vpath.getVPathInfo(file, req.user);
        await fs.access(pathInfo.fullPath);
        entries.push({ abs: pathInfo.fullPath, name: path.basename(file) });
      } catch (err) {
        winston.warn(`Failed to access file ${file} for download, skipping.`, { stack: err });
      }
    }
    await enforceFileLimit(entries.map(e => e.abs));

    const archive = new ZipArchive();

    archive.on('error', err => {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: typeof err === 'string' ? err : 'Unknown Error' });
    });

    res.attachment(`mstream-playlist.zip`);

    //streaming magic
    archive.pipe(res);

    for (const { abs, name } of entries) {
      archive.file(abs, { name });
    }

    archive.finalize();
  }
}
