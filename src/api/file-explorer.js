import path from 'path';
import fs from 'fs/promises';
import fsOld from 'fs';
import busboy from 'busboy';
import Joi from 'joi';
import winston from 'winston';
import * as fileExplorer from '../util/file-explorer.js';
import * as vpath from '../util/vpath.js';
import * as m3u from '../util/m3u.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  mstream.post("/api/v1/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().allow("").required(),
      sort: Joi.boolean().default(true),
      pullMetadata: Joi.boolean().default(false)
    });
    const { value } = joiValidate(schema, req.body);

    // Convenience functions to get the most useful directory
    if (value.directory === "~") {
      if (req.user.vpaths.length !== 1) {
        value.directory = "";
      } else {
        value.directory = `/${req.user.vpaths[0]}`;
      }
    }

    // Return vpaths if no path is given
    if (value.directory === "" || value.directory === "/") {
      const directories = [];
      for (const dir of req.user.vpaths) {
        directories.push({ name: dir });
      }
      return res.json({ path: "/", directories: directories, files: [] });
    }

    // Get vPath Info
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);

    // Bounds check is handled by getVPathInfo — it throws if fullPath escapes basePath

    // get directory contents. A folder that is gone, is a file, or is
    // unreadable is the caller's path, not a crash — it used to surface as
    // an unhandled 500. pathReadError maps the fs code to 404/400; the
    // message shows the caller's VIRTUAL path, never the library's root.
    let folderContents;
    try {
      folderContents = await fileExplorer.getDirectoryContents(pathInfo.fullPath, config.program.supportedAudioFiles, value.sort, value.pullMetadata, value.directory, req.user);
    } catch (err) {
      throw fileExplorer.pathReadError(value.directory, err);
    }

    // Format directory string for return value
    let returnDirectory = path.join(pathInfo.vpath, pathInfo.relativePath);
    returnDirectory = returnDirectory.replace(/\\/g, "/"); // Formatting for windows paths

    // Make sure we have a slash at the beginning & end
    if (returnDirectory.slice(1) !== "/") { returnDirectory = "/" + returnDirectory; }
    if (returnDirectory.slice(-1) !== "/") { returnDirectory += "/"; }

    res.json({
      path: returnDirectory,
      files: folderContents.files,
      directories: folderContents.directories
    });
  });

  async function recursiveFileScan(directory, fileList, relativePath, vPath) {
    for (const file of await fs.readdir(directory)) {
      let stat;
      try {
        stat = await fs.stat(path.join(directory, file));
      } catch (err) {
        /* Bad file or permission error, ignore and continue */
        winston.warn(`Failed to access file ${file} in directory ${directory}, skipping.`, { stack: err });
        continue;
      }

      if (stat.isDirectory()) {
        await recursiveFileScan(path.join(directory, file), fileList, path.join(relativePath, file), vPath);
      } else {
        const extension = fileExplorer.getFileType(file).toLowerCase();
        if (config.program.supportedAudioFiles[extension] === true) {
          fileList.push(path.join(vPath, path.join(relativePath, file)).replace(/\\/g, "/"));
        }
      }
    }
    return fileList;
  }

  mstream.post("/api/v1/file-explorer/recursive", async (req, res) => {
    const schema = Joi.object({ directory: Joi.string().required() });
    joiValidate(schema, req.body);

    // Get vPath Info
    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);

    // Bounds check is handled by getVPathInfo

    let files;
    try {
      files = await recursiveFileScan(pathInfo.fullPath, [], pathInfo.relativePath, pathInfo.vpath);
    } catch (err) {
      throw fileExplorer.pathReadError(req.body.directory, err);
    }
    res.json(files);
  });

  mstream.post("/api/v1/file-explorer/mkdir", async (req, res) => {
    if (config.program.noMkdir === true) { throw new WebError('Create Folder Disabled', 403); }
    if (req.user.allow_mkdir === false || req.user.allow_mkdir === 0) { throw new WebError('Create Folder Disabled', 403); }

    const schema = Joi.object({
      directory: Joi.string().required(),
    });
    const { value } = joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(value.directory, req.user);

    // Bounds check is handled by getVPathInfo

    await fs.mkdir(pathInfo.fullPath, { recursive: true });
    res.json({});
  });

  mstream.post('/api/v1/file-explorer/upload', (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled', 403); }
    if (req.user.allow_upload === false || req.user.allow_upload === 0) { throw new WebError('Uploading Disabled', 403); }
    if (!req.headers['data-location']) { throw new WebError('No Location Provided', 403); }

    const pathInfo = vpath.getVPathInfo(decodeURI(req.headers['data-location']), req.user);
    fsOld.mkdirSync(pathInfo.fullPath, { recursive: true });

    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
    bb.on('file', (fieldname, file, info) => {
      // Sanitize filename — strip path separators and traversal sequences
      const rawName = info.filename || 'upload';
      const safeName = path.basename(rawName.replace(/\\/g, '/'));
      if (!safeName || safeName === '.' || safeName === '..') {
        file.resume(); // drain the stream
        return;
      }
      const saveTo = path.join(pathInfo.fullPath, safeName);
      // Final check — resolved path must stay within the upload directory
      if (!saveTo.startsWith(pathInfo.fullPath)) {
        winston.warn(`Upload filename escaped directory: ${rawName}`);
        file.resume();
        return;
      }
      winston.info(`Uploading from ${req.user.username} to: ${saveTo}`);
      file.pipe(fsOld.createWriteStream(saveTo));
    });

    bb.on('close', () => { res.json({}); });
    req.pipe(bb);
  });

  mstream.post("/api/v1/file-explorer/m3u", async (req, res) => {
    // Validate up front: a missing `path` used to reach getVPathInfo as
    // undefined and die with a TypeError (500).
    joiValidate(Joi.object({ path: Joi.string().required() }), req.body);
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    const playlistParentDir = path.dirname(req.body.path);
    let songs;
    try {
      songs = await m3u.readPlaylistSongs(pathInfo.fullPath);
    } catch (err) {
      throw fileExplorer.pathReadError(req.body.path, err, 'playlist');
    }
    const vpathRoot = path.resolve(pathInfo.basePath);
    const playlistDir = path.dirname(pathInfo.fullPath);

    // Defense-in-depth: every entry must resolve within the library root.
    const safe = [];
    let skipped = 0;
    for (const song of songs) {
      const resolved = path.resolve(playlistDir, song);
      if (resolved === vpathRoot || resolved.startsWith(vpathRoot + path.sep)) {
        safe.push(song);
      } else {
        skipped += 1;
      }
    }

    res.json({
      files: safe.map((song) => ({
        type: fileExplorer.getFileType(song),
        name: path.basename(song),
        path: path.join(playlistParentDir, song).replace(/\\/g, '/'),
      })),
      skipped,
    });
  });
}
