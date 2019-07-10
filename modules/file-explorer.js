const Busboy = require("busboy");
const fs = require("fs");
const fe = require("path");
const archiver = require('archiver');
const winston = require('winston');
const mkdirp = require('mkdirp');

const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus"];

exports.setup = function(mstream, program) {
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

    mkdirp(pathInfo.fullPath, function(err) {
      if (err) {
        res.status(500).json({ error: 'Mkdirp failed to create requested path' });
      } else {
        const busboy = new Busboy({ headers: req.headers });

        busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
          const saveTo = fe.join(pathInfo.fullPath, filename);
          winston.info(`Uploading from ${req.user.username} to: ${saveTo}`);
          file.pipe(fs.createWriteStream(saveTo));
        });

        busboy.on("finish", function () {
          res.json({ success: true });
        });

        req.pipe(busboy);
      }
    });
  });

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

    // Will only show these files.  Prevents people from snooping around
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
