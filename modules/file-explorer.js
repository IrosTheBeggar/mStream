const Busboy = require("busboy");
const fs = require("fs");
const fe = require("path");
const archiver = require('archiver');
const winston = require('winston');
const mkdirp = require('make-dir');
const m3u8Parser = require('m3u8-parser');

const masterFileTypes = {
  "mp3": true,
  "flac": true,
  "wav": true,
  "ogg": true,
  "aac": true,
  "m4a": true,
  "opus": true,
  "m3u": false
}

exports.setup = function(mstream, program) {

  function getPathInfoOrThrow(req, pathString) {
    const pathInfo = program.getVPathInfo(pathString, req.user);
    if (pathInfo === false) {
      throw {code: 500, json: { error: "Could not find file" }};
    }
    return pathInfo;
  }

  function getFileType(pathString) {
    return fe.extname(pathString).substr(1);
  }

  function readPlaylistSongs(pathString) {
    const parser = new m3u8Parser.Parser();
    const fileContents = fs.readFileSync(pathString).toString();
    parser.push(fileContents);
    parser.end();
    let items = parser.manifest.segments.map(segment => { return segment.uri; });
    if (items.length === 0) {
      items = fileContents.split(/\r?\n/).filter(Boolean);
    }
    return items.map(item => { return item.replace(/\\/g, "/"); });
  }

  function handleError(error, res) {
    if (error.code && error.json) {
      res.status(error.code).json(error.json);
    }
  }

  mstream.post('/download-directory', (req, res) => {
    if (!req.body.directory) {
      return res.status(500).json({ error: 'Missing Params' });
    }

    // Get full path
    const pathInfo = program.getVPathInfo(req.body.directory, req.user);
    if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
    }

    const archive = archiver('zip');
    archive.on('error', function (err) {
      winston.error(`Download Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    });

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
      const playlistParentDir = fe.dirname(playlistPathInfo.fullPath);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      const archive = archiver('zip');
      archive.on('error', function (err) {
        winston.error(`Download Error: ${err.message}`);
        res.status(500).json({ error: err.message });
      });
      res.attachment(fe.basename(req.body.path) + ".zip");
      archive.pipe(res);
      for (let song of songs) {
        const songPath = fe.join(playlistParentDir, song);
        archive.file(songPath, { name: fe.basename(song) });
      }
      archive.finalize();
    } catch (error) {
      handleError(error, res);
    }
  });

  mstream.post("/upload", function (req, res) {
    if (program.noUpload) {
      return res.status(500).json({ error: 'Uploading Disabled' });
    }

    if (!req.headers['data-location']) {
      return res.status(500).json({ error: 'No Location Provided' });
    }
    const pathInfo = program.getVPathInfo(decodeURI(req.headers['data-location']), req.user);
    if (!pathInfo) { return res.status(500).json({ error: 'Location could not be parsed' }); }

    // run make directory
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
      const playlistParentDir = fe.dirname(req.body.path);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      res.json({
        contents: songs.map(function (song) {
          return { type: getFileType(song), name: fe.basename(song), path: fe.join(playlistParentDir, song).replace(/\\/g, '/') }
        })
      })
    } catch (error) {
      handleError(error, res);
    }
  })

  mstream.post("/fileplaylist/loadpaths", function(req, res, next) {
    try {
      const playlistPathInfo = getPathInfoOrThrow(req, req.body.path);
      const playlistParentDir = fe.dirname(req.body.path);
      const songs = readPlaylistSongs(playlistPathInfo.fullPath);
      res.json(songs.map(function (song) { return fe.join(playlistParentDir, song).replace(/\\/g, '/'); }));
    } catch (error) {
      handleError(error, res);
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

    const pathInfo = program.getVPathInfo(req.body.dir, req.user);
    if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
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
        if (extension in masterFileTypes) {
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
    let returnDirectory = req.body.dir.replace(/\\/g, "/");
    if (returnDirectory.slice(-1) !== "/") {
      returnDirectory += "/";
    }

    // Send back combined list of directories and mp3s
    res.json({ path: returnDirectory, contents: directories.concat(filesArray) });
  });

  mstream.post('/files/recursive-scan', function(req, res){
    if (!req.body.dir) {
      return res.status(422).json({ error: "Missing Directory" });
    }

    const pathInfo = program.getVPathInfo(req.body.dir, req.user);
    if (!pathInfo) { return res.status(500).json({ error: "Could not parse directory" }); }

    // Make sure it's a directory
    if (!fs.statSync(pathInfo.fullPath).isDirectory()) {
      res.status(500).json({ error: "Not a directory" });
      return;
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
          if (masterFileTypes[extension] === true) {
            filelist.push(fe.join(pathInfo.vpath, fe.join(relativePath, file)).replace(/\\/g, "/"));
          }
        }
      });
      return filelist;
    }

    res.json(recursiveTrot(pathInfo.fullPath, [], pathInfo.relativePath));
  });
};
