const path = require('path');
const fs = require('fs').promises;
const fsOld = require('fs');
const busboy = require("busboy");
const Joi = require('joi');
const winston = require('winston');
const fileExplorer = require('../util/file-explorer');
const vpath = require('../util/vpath');
const m3u = require('../util/m3u');
const config = require('../state/config');
const { joiValidate } = require('../util/validation');
const WebError = require('../util/web-error');

exports.setup = (mstream) => {
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
      for (let dir of req.user.vpaths) {
        directories.push({ name: dir });
      }
      return res.json({ path: "/", directories: directories, files: [] });
    }

    // Get vPath Info
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);

    // get directory contents
    const folderContents = await fileExplorer.getDirectoryContents(pathInfo.fullPath, config.program.supportedAudioFiles, value.sort, value.pullMetadata, value.directory, req.user);

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
      try {
        var stat = await fs.stat(path.join(directory, file));
      } catch (e) { continue; } /* Bad file or permission error, ignore and continue */
    
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

    res.json(await recursiveFileScan(pathInfo.fullPath, [], pathInfo.relativePath, pathInfo.vpath));
  });

  mstream.post('/api/v1/file-explorer/upload', async (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled'); }
    if (!req.headers['data-location']) { throw new WebError('No Location Provided', 403); } 

    const pathInfo = vpath.getVPathInfo(decodeURI(req.headers['data-location']), req.user);
    await fs.mkdir(pathInfo.fullPath, { recursive: true });

    const bb = busboy({ headers: req.headers });
    bb.on('file', (fieldname, file, info) => {
      const { filename } = info;
      const saveTo = path.join(pathInfo.fullPath, filename);
      winston.info(`Uploading from ${req.user.username} to: ${saveTo}`);
      file.pipe(fsOld.createWriteStream(saveTo));
    });

    bb.on('close', () => { res.json({}); });
    req.pipe(bb);
  });

  mstream.post("/api/v1/file-explorer/m3u", async (req, res) => {
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    const playlistParentDir = path.dirname(req.body.path);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);
    res.json({
      files: songs.map((song) => {
        return { 
          type: fileExplorer.getFileType(song),
          name: path.basename(song),
          path: path.join(playlistParentDir, song).replace(/\\/g, '/')
        };
      })
    });
  });

  mstream.post("/api/v1/file-explorer/rename", async (req, res) => {
    const schema = Joi.object({ 
      path: Joi.string().required(),
      newName: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    // check permissions
    if (config.program.folders[pathInfo.vpath].edit.rename !== true) { throw new WebError('Rename Disabled'); }
    if (req.user.editFilePrivileges.rename !== true) { throw new WebError('Rename Disabled'); }

    // check if path exists
    await fs.stat(pathInfo.fullPath);

    // rename
    const newt = path.join(path.dirname(pathInfo.fullPath), req.body.newName);
    await fs.rename(pathInfo.fullPath, newt);

    res.json({});
  });

  mstream.delete("/api/v1/file-explorer/delete", async (req, res) => {
    const schema = Joi.object({ path: Joi.string().required() });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    // check permissions
    if (config.program.folders[pathInfo.vpath].edit.delete !== true) { throw new WebError('Rename Disabled'); }
    if (req.user.editFilePrivileges.delete !== true) { throw new WebError('Rename Disabled'); }

    // check if path exists
    const stat = await fs.stat(pathInfo.fullPath);

    if (stat.isDirectory()) {
      await fs.rm(pathInfo.fullPath);
    } else {
      await fs.unlink(pathInfo.fullPath);
    }

    // delete
    res.json({});
  });

  // mstream.post("/api/v1/file-explorer/move", async (req, res) => {

  // });

  mstream.post("/api/v1/file-explorer/mkdir", async (req, res) => {
    const schema = Joi.object({ path: Joi.string().required(), newDirName: Joi.string().required() });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    // check permissions
    if (config.program.folders[pathInfo.vpath].edit.mkdir !== true) { throw new WebError('Rename Disabled'); }
    if (req.user.editFilePrivileges.mkdir !== true) { throw new WebError('Rename Disabled'); }

    await fs.mkdir(pathInfo.fullPath, { recursive: true });
  });
}