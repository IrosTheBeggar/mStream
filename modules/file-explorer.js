const Busboy = require("busboy");
const fs = require("fs");
const fe = require("path");
const archiver = require('archiver');
const winston = require('winston');
const mkdirp = require('make-dir');
const m3uread = require('m3u8-reader')

const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus", "m3u"];

exports.setup = function(mstream, program) {

  function getPathInfoOrThrow(req, path) {
    const pathInfo = program.getVPathInfo(path);
    if (pathInfo == false) {
      throw {code: 500, json: { error: "Could not find file" }};
    }
    if (!req.user.vpaths.includes(pathInfo.vpath)) {
      throw {code: 500, json: { error: "Access Denied" }};
    }
    return pathInfo;
  }

  function getPathArray(path) {
    return path.split("/").filter(Boolean)
  }

  function getParentDirPath(path) {
    return getPathArray(path).slice(0, -1).join("/");
  }

  function readPlaylistSongs(path) {
    return m3uread(fs.readFileSync(path))
      .filter(function (item) { return typeof item === "string" })
      .map(function (item) { return item.replace(/\\/g, "/") }) // m3u path separated by \
  }

  function getFileName(path) {
    return getPathArray(path).pop()
  }

  function joinPaths(path1, path2) {
    return getPathArray(path1).concat(getPathArray(path2)).join("/")
  }

  function handleError(error, res, next) {
    if (error.code && error.json) {
      res.status(error.code).json(error.json);
    } else {
      next(error);
    }
  }

  function setArchiverErrorHandler(archive, res) {
    archive.on('error', function (err) {
      winston.error(`Download Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    });
  }

  mstream.post('/download-directory', (req, res) => {
    if (!req.body.directory) {
      return res.status(500).json({ error: 'Missing Params' });
    }

    // Get full path
    const pathInfo = program.getVPathInfo(req.body.directory);
    if (pathInfo == false) {
      res.status(500).json({ error: "Could not find file" });
      return;
    }

    // Make sure the user has access to the given vpath and that the vpath exists
    if (!req.user.vpaths.includes(pathInfo.vpath)) {
      res.status(500).json({ error: "Access Denied" });
      return;
    }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
    }

    const archive = archiver('zip');
    setArchiverErrorHandler(archive, res);

    // sets the archive name. TODO: Rename this
    res.attachment('zipped-playlist.zip');

    // streaming magic
    archive.pipe(res);
    archive.directory(pathInfo.fullPath, false);
    archive.finalize();
  });

  mstream.post('/fileplaylist/download', (req, res, next) => {
    try {
      const playlistPathInfo = getPathInfoOrThrow(req, req.body.path);
      const playlistParentDir = getParentDirPath(req.body.path);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      const archive = archiver('zip');
      setArchiverErrorHandler(archive, res);
      res.attachment(getFileName(req.body.path) + ".zip");
      archive.pipe(res);
      for (let song of songs) {
        const songPath = joinPaths(playlistParentDir, song);
        const songPathInfo = getPathInfoOrThrow(req, songPath);
        archive.file(songPathInfo.fullPath, { name: getFileName(song) })
      }
      archive.finalize();
    } catch (error) {
      handleError(error, res, next);
    }
  });

  mstream.post("/upload", function (req, res) {
    if (program.noUpload) {
      return res.status(500).json({ error: 'Uploading Disabled' });
    }

    if (!req.headers['data-location']) {
      return res.status(500).json({ error: 'No Location Provided' });
    }
    const pathInfo = program.getVPathInfo(req.headers['data-location']);
    if (!pathInfo.fullPath) {
      return res.status(500).json({ error: 'Location could not be parsed' });
    }

    // TODO: Check if path exits, if not make the path
    try {
      mkdirp.sync(pathInfo.fullPath);
    } catch (err) {
      winston.error(err.message);
      return res.status(500).json({ error: 'Mkdirp failed to create requested path' });
    }

    const busboy = new Busboy({ headers: req.headers });

    busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      const saveTo = fe.join(pathInfo.fullPath, filename);
      winston.info(`Uploading from ${req.user.username} to: ${saveTo}`);
      file.pipe(fs.createWriteStream(saveTo));
    });

    busboy.on("finish", function () {
      res.json({ success: true });
    });

    return req.pipe(busboy);
  });

  mstream.post("/fileplaylist/load", function(req, res, next) {
    try {
      const playlistPathInfo = getPathInfoOrThrow(req, req.body.path);
      const playlistParentDir = getParentDirPath(req.body.path);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      res.json({
        contents: songs.map(function (song) {
          return {type: getFileType(song), name: getFileName(song), path: joinPaths(playlistParentDir, song)}
        })
      })
    } catch (error) {
      handleError(error, res, next);
    }
  })

  mstream.post("/fileplaylist/loadpaths", function(req, res, next) {
    try {
      const playlistPathInfo = getPathInfoOrThrow(req, req.body.path);
      const playlistParentDir = getParentDirPath(req.body.path);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      res.json(songs.map(function (song) { return joinPaths(playlistParentDir, song); }));
    } catch (error) {
      handleError(error, res, next);
    }
  })

  // parse directories
  mstream.post("/dirparser", function(req, res) {
    const directories = [];
    const filesArray = [];

    // Return vpaths if no path is given
    if (req.body.dir === "" || req.body.dir === "/") {
      for (let dir of req.user.vpaths) {
        directories.push({
          type: "directory",
          name: dir
        });
      }
      return res.json({ path: "/", contents: directories });
    }

    const directory = req.body.dir;
    const pathInfo = program.getVPathInfo(directory);
    if (pathInfo == false) {
      res.status(500).json({ error: "Could not find file" });
      return;
    }

    // Make sure the user has access to the given vpath and that the vpath exists
    if (!req.user.vpaths.includes(pathInfo.vpath)) {
      res.status(500).json({ error: "Access Denied" });
      return;
    }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
    }

    var fileTypesArray;
    if (req.body.filetypes) {
      fileTypesArray = req.body.filetypes;
    } else {
      fileTypesArray = masterFileTypesArray;
    }

    // get directory contents
    const files = fs.readdirSync(pathInfo.fullPath);

    // loop through files
    for (let i = 0; i < files.length; i++) {
      try {
        var stat = fs.statSync(fe.join(pathInfo.fullPath, files[i]));
      } catch (error) {
        // Bad file, ignore and continue
        continue;
      }

      // Handle Directories
      if (stat.isDirectory()) {
        directories.push({
          type: "directory",
          name: files[i]
        });
      } else {
        // Handle Files
        const extension = getFileType(files[i]).toLowerCase();
        if (fileTypesArray.indexOf(extension) > -1 && masterFileTypesArray.indexOf(extension) > -1) {
          filesArray.push({
            type: extension,
            name: files[i]
          });
        }
      }
    }

    // Sort it because we can't rely on the OS returning it pre-sorted
    directories.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });
    filesArray.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });

    // Format directory string for return value
    let returnDirectory = directory.replace(/\\/g, "/");
    if (returnDirectory.slice(-1) !== "/") {
      returnDirectory += "/";
    }

    // Send back combined list of directories and mp3s
    res.json({ path: returnDirectory, contents: directories.concat(filesArray) });
  });

  mstream.post('/files/recursive-scan', function(req, res){
    if(!req.body.dir) {
      return res.status(422).json({ error: "Missing Directory" });
    }

    const directory = req.body.dir;
    const pathInfo = program.getVPathInfo(directory);
    if (pathInfo == false) {
      res.status(500).json({ error: "Could not find file" });
      return;
    }

    // Make sure the user has access to the given vpath and that the vpath exists
    if (!req.user.vpaths.includes(pathInfo.vpath)) {
      res.status(500).json({ error: "Access Denied" });
      return;
    }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
    }

    // Will only show these files.  Prevents people from snooping around
    var fileTypesArray;
    if (req.body.filetypes) {
      fileTypesArray = req.body.filetypes;
    } else {
      fileTypesArray = masterFileTypesArray;
    }

    const recursiveTrot = function(dir, filelist, relativePath) {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        try {
          var stat = fs.statSync(fe.join(dir, file));
        } catch (error) {
          // Bad file, ignore and continue
          return;
        }

        if (stat.isDirectory()) {
          recursiveTrot(fe.join(dir, file), filelist, fe.join(relativePath, file));
        } else {
          const extension = getFileType(file).toLowerCase();
          if (fileTypesArray.indexOf(extension) > -1 && masterFileTypesArray.indexOf(extension) > -1) {
            filelist.push(fe.join(pathInfo.vpath, fe.join(relativePath, file)));
          }
        }
      });
      return filelist;
    }

    res.json(recursiveTrot(pathInfo.fullPath, [], pathInfo.relativePath));
  });

  function getFileType(filename) {
    return filename.split(".").pop();
  }
};
