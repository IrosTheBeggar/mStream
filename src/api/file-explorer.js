const winston = require('winston');
const fileExplorer = require('../util/file-explorer');

exports.setup = (mstream, program) => {
  mstream.post("/api/v1/file-explorer", async (req, res) => {
    try {
      // Return vpaths if no path is given
      if (!req.body.dir || req.body.dir === "" || req.body.dir === "/") {
        const directories = [];
        for (let dir of req.user.vpaths) {
          directories.push({
            type: "directory",
            name: dir
          });
        }
        return res.json({ path: "/", directories: directories, files: [] });
      }

      // Get vPath Info
      const pathInfo = program.getVPathInfo(req.body.dir, req.user);
      if (!pathInfo) { return res.status(500).json({ error: "Could not find file" }); }

      // Do not allow browsing outside the directory
      if (pathInfo.fullPath.substring(0, pathInfo.basePath.length) !== pathInfo.basePath) {
        winston.warn(`user '${req.user.username}' attempted to access a directory they don't have access to: ${pathInfo.fullPath}`)
        throw 'Access to directory not allowed';
      }

      // get directory contents
      const folderContents =  await fileExplorer.getDirectoryContents(pathInfo.fullPath, program.supportedAudioFiles);

      // Format directory string for return value
      let returnDirectory = req.body.dir.replace(/\\/g, "/");
      if (returnDirectory.slice(-1) !== "/") { returnDirectory += "/"; }

      res.json({ path: returnDirectory, files: folderContents.files, directories: folderContents.directories });
    } catch (err) {
      res.status(500).json({ error: "Failed to get directory contents" });
    }
  });
}