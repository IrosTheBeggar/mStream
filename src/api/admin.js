const path = require('path');
const Joi = require('joi');
const fileExplorer = require('../util/file-explorer');
const admin = require('../util/admin');
const globals = require('../global');

exports.setup = (mstream) => {
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

      const folderContents =  await fileExplorer.getDirectoryContents(thisDirectory, {}, true);

      res.json({
        path: thisDirectory,
        directories: folderContents.directories,
        files: folderContents.files
      });
    }catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to get directory contents' });
    }
  });

  mstream.get("/api/v1/admin/directories", async (req, res) => {
    try {
      res.json(globals.program.folders);
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to get vpaths' });
    }
  }); 

  mstream.get("/api/v1/admin/users", async (req, res) => {
    try {
      // Scrub passwords
      const memClone = JSON.parse(JSON.stringify(globals.program.users));
      Object.keys(memClone).forEach(key => {
        if(key === 'password' || key === 'salt') {
          delete memClone[key];
        }
      });

      res.json(memClone);
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to get vpaths' });
    }
  });

  mstream.put("/api/v1/admin/directory", async (req, res) => {
    try {
      const schema = Joi.object({
        directory: Joi.string().required(),
        vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.addDirectory(req.body.directory, req.body.vpath, globals.program, mstream);
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to set new directory' });
    }
  });

  mstream.put("/api/v1/admin/user", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
        vpaths: Joi.array().items(Joi.string()).required(),
        admin: Joi.boolean().optional().default(false),
        guest: Joi.boolean().optional().default(false)
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.addUser(
        req.body.username,
        req.body.password,
        req.body.admin,
        req.body.guest,
        req.body.vpaths,
        globals.program
      );
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to set new directory' });
    }
  });

  // mstream.delete("/api/v1/admin/directory", async (req, res) => {
  //   try {
  //     const schema = Joi.object({
  //       vpath: Joi.string().pattern().required()
  //     });
  //     await schema.validateAsync(req.body);
  //   }catch (err) {
  //     return res.status(500).json({ error: 'Validation Error' });
  //   }

  //   try {

  //   } catch (err) {
      
  //   }
  // });
}