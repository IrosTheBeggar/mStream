const Busboy = require("busboy");
const fs = require("fs").promises;
const path = require("path");
const archiver = require('archiver');
const winston = require('winston');
const mkdirp = require('make-dir');
const m3u8Parser = require('m3u8-parser');

exports.setup = (mstream, program) => {
  function getFileType(pathString) {
    return path.extname(pathString).substr(1);
  }

  mstream.post("/api/v1/file-explorer", async (req, res) => {
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

    try {
      const pathInfo = program.getVPathInfo(req.body.dir, req.user);
      if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }
  
      const files = await fs.readdir(pathInfo.fullPath);
      for (const file of files) {
        try {
          var stat = await fs.stat(path.join(pathInfo.fullPath, file));
        } catch (e) { return; /* Bad file, ignore and continue */ }

        // Handle Directory
        if (stat.isDirectory()) {
          directories.push({
            type: "directory",
            name: file
          });
          continue;
        }

        // Handle Files
        const extension = getFileType(file).toLowerCase();
        if (extension in program.supportedAudioFiles) {
          filesArray.push({
            type: extension,
            name: file
          });
        }
      }

      // Sort it because we can't rely on the OS returning it pre-sorted
      directories.sort((a, b) => { return a.name.localeCompare(b.name); });
      filesArray.sort((a, b) => { return a.name.localeCompare(b.name); });
  
      // Format directory string for return value
      let returnDirectory = req.body.dir.replace(/\\/g, "/");
      if (returnDirectory.slice(-1) !== "/") {
        returnDirectory += "/";
      }

      res.json({ path: returnDirectory, contents: directories.concat(filesArray) });
    } catch (err) {
      res.status(500).json({ error: "Failed to get directory contents" });
    }
  });
}