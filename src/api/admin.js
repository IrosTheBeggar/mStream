const path = require('path');
const Joi = require('joi');
const fileExplorer = require('../util/file-explorer');

exports.setup = (mstream, program) => {
  // The admin file explorer can view the entire system
  mstream.post("/api/v1/admin/file-explorer", async (req, res) => {
    try {
      const schema = Joi.object({
        directory: Joi.string().required(),
        joinDirectory: Joi.string().optional()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      // Handle home directory
      let thisDirectory = req.body.directory; 
      if (req.body.directory === '~') {
        thisDirectory = require('os').homedir();
      }

      if (req.body.joinDirectory) {
        thisDirectory = path.join(thisDirectory, req.body.joinDirectory);
      }

      const folderContents =  await fileExplorer.getDirectoryContents(thisDirectory, {});

      res.json({
        path: thisDirectory,
        directories: folderContents.directories,
        files: folderContents.files
      });
    }catch (err) {
      return res.status(500).json({ error: 'Failed to get directory contents' });
    }
  });
}