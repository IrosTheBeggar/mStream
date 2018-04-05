exports.setup = function(mstream, program) {
  const fs = require("fs"); // File System
  const fe = require("path");
  const masterFileTypesArray = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];

  // parse directories
  mstream.post("/dirparser", function(req, res) {
    var directories = [];
    var filesArray = [];

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

    var directory = req.body.dir;
    let pathInfo = program.getVPathInfo(directory);
    if (pathInfo == false) {
      res.status(500).json({ error: "Could not find file" });
      return;
    }

    // Make sure the user has access to the given vpath and that the vapth exists
    if (!req.user.vpaths.includes(pathInfo.vpath)) {
      res.status(500).json({ error: "Access Denied" });
      return;
    }

    var path = pathInfo.fullPath;

    // Make sure it's a directory
    if (!fs.statSync(path).isDirectory()) {
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
    var files = fs.readdirSync(path);

    // loop through files
    for (let i = 0; i < files.length; i++) {
      try {
        var stat = fs.statSync(fe.join(path, files[i]));
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
        var extension = getFileType(files[i]);
        if (
          fileTypesArray.indexOf(extension) > -1 &&
          masterFileTypesArray.indexOf(extension) > -1
        ) {
          filesArray.push({
            type: extension,
            name: files[i]
          });
        }
      }
    }

    // Sort it becasue we can't rely on the OS returning it pre-sorted
    directories.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });
    filesArray.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });

    // Format direcotry string for retrun value
    directory = directory.replace(/\\/g, "/");
    if (directory.slice(-1) !== "/") {
      directory += "/";
    }

    // Send back combined list of directories and mp3s
    res.json({ path: directory, contents: directories.concat(filesArray) });
  });

  function getFileType(filename) {
    return filename.split(".").pop();
  }
};
