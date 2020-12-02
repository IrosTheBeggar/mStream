const Joi = require('joi');
const fileExplorer = require('../util/file-explorer');

exports.setup = (mstream, program) => {
  // The admin file explorer can view the entire system
  mstream.post("/api/v1/admin/file-explorer", async (req, res) => {
    try {
      const schema = Joi.object({ directory: Joi.string().required() });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      // Handle home directory
      if(req.body.directory === '~') {
        req.body.directory = require('os').homedir();
      }

      const folderContents =  await fileExplorer.getDirectoryContents(pathInfo.fullPath, program.supportedAudioFiles);
      
      res.json({ path: returnDirectory, directories: folderContents.directories, files: folderContents.files });
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }
  });
}