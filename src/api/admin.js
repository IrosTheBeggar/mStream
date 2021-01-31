const path = require('path');
const Joi = require('joi');
const winston = require('winston');
const archiver = require('archiver');
const fileExplorer = require('../util/file-explorer');
const admin = require('../util/admin');
const config = require('../state/config');
const dbQueue = require('../db/task-queue');
const transcode = require('./transcode');

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

      const folderContents = await fileExplorer.getDirectoryContents(thisDirectory, {}, true);

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
      res.json(config.program.folders);
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to get vpaths' });
    }
  });

  mstream.get("/api/v1/admin/db/params", async (req, res) => {
    try {
      res.json(config.program.scanOptions);
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to get scan options' });
    }
  });

  mstream.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    try {
      const schema = Joi.object({
        scanInterval: Joi.number().integer().min(0).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editScanInterval(req.body.scanInterval);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/db/params/save-interval", async (req, res) => {
    try {
      const schema = Joi.object({
        saveInterval: Joi.number().integer().min(0).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editSaveInterval(req.body.saveInterval);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    try {
      const schema = Joi.object({
        skipImg: Joi.boolean().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editSkipImg(req.body.skipImg);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/db/params/pause", async (req, res) => {
    try {
      const schema = Joi.object({
        pause:  Joi.number().integer().min(0).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editPause(req.body.pause);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    try {
      const schema = Joi.object({
        bootScanDelay:  Joi.number().integer().min(0).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editBootScanDelay(req.body.bootScanDelay);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/db/params/max-concurrent-scans", async (req, res) => {
    try {
      const schema = Joi.object({
        maxConcurrentTasks:  Joi.number().integer().min(0).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editMaxConcurrentTasks(req.body.maxConcurrentTasks);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.get("/api/v1/admin/users", async (req, res) => {
    try {
      // Scrub passwords
      const memClone = JSON.parse(JSON.stringify(config.program.users));
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
        vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
        autoAccess: Joi.boolean().default(false)
      });
      var input = await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.addDirectory(input.directory, input.vpath, input.autoAccess, mstream);
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to set new directory' });
    }

    try {
      dbQueue.scanVPath(input.vpath);
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
  });

  mstream.delete("/api/v1/admin/directory", async (req, res) => {
    try {
      const schema = Joi.object({
        vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.removeDirectory(req.body.vpath);
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to set new directory' });
    }
  });

  mstream.put("/api/v1/admin/users", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
        vpaths: Joi.array().items(Joi.string()).required(),
        admin: Joi.boolean().optional().default(false),
        guest: Joi.boolean().optional().default(false)
      });
      var input = await schema.validateAsync(req.body);
    }catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.addUser(
        input.username,
        input.password,
        input.admin,
        input.guest,
        input.vpaths
      );
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to set new directory' });
    }
  });

  mstream.post("/api/v1/admin/db/scan/all", async (req, res) => {
    try {
      dbQueue.scanAll();
      res.json({});
    } catch(err) {
      res.status(500).json({});
    }
  });

  mstream.get("/api/v1/admin/db/scan/stats", async (req, res) => {
    try {
      res.json(dbQueue.getAdminStats());
    } catch(err) {
      res.status(500).json({});
    }
  });

  mstream.delete("/api/v1/admin/users", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try { 
      await admin.deleteUser(req.body.username);
      res.json({});
    } catch (err) {
      console.log(err)
      return res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  mstream.post("/api/v1/admin/users/password", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editUserPassword(req.body.username, req.body.password);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to update password' });
    }
  });

  mstream.post("/api/v1/admin/users/lastfm", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        lasftfmUser: Joi.string().required(),
        lasftfmPassword: Joi.string().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.setUserLastFM(req.body.username, req.body.password);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to update password' });
    }
  });

  mstream.post("/api/v1/admin/users/vpaths", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        vpaths: Joi.array().items(Joi.string()).required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editUserVPaths(req.body.username, req.body.vpaths);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  });

  mstream.post("/api/v1/admin/users/access", async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        admin: Joi.boolean().required(),
        guest: Joi.boolean().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editUserAccess(req.body.username, req.body.admin, req.body.guest);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  });

  mstream.get("/api/v1/admin/config", async (req, res) => {
    try {
      res.json({
        address: config.program.address,
        port: config.program.port,
        noUpload: config.program.noUpload,
        writeLogs: config.program.writeLogs,
        secret: config.program.secret.slice(-4),
        ssl: config.program.ssl,
        storage: config.program.storage
      });
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/config/port", async (req, res) => {
    try {
      const schema = Joi.object({
        port: Joi.number().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editPort(req.body.port);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/config/address", async (req, res) => {
    try {
      const schema = Joi.object({
        address: Joi.string().ip({ cidr: 'forbidden' }).required(),
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editAddress(req.body.address);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/config/noupload", async (req, res) => {
    try {
      const schema = Joi.object({
        noUpload: Joi.boolean().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editUpload(req.body.noUpload);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/config/write-logs", async (req, res) => {
    try {
      const schema = Joi.object({
        writeLogs: Joi.boolean().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editWriteLogs(req.body.writeLogs);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/config/secret", async (req, res) => {
    try {
      const schema = Joi.object({
        strength: Joi.number().integer().positive().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      const secret = await config.asyncRandom(req.body.strength);
      await admin.editSecret(secret);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.get("/api/v1/admin/transcode", async (req, res) => {
    try {
      const memClone = JSON.parse(JSON.stringify(config.program.transcode));
      memClone.downloaded = transcode.isDownloaded();
      res.json(memClone);
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed to get scan options' });
    }
  });

  mstream.post("/api/v1/admin/transcode/enable", async (req, res) => {
    try {
      const schema = Joi.object({
        enable: Joi.boolean().required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.enableTranscode(req.body.enable);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/transcode/default-codec", async (req, res) => {
    try {
      const schema = Joi.object({
        defaultCodec: Joi.string().valid('mp3', 'opus', 'aac').required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editDefaultCodec(req.body.defaultCodec);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/transcode/default-bitrate", async (req, res) => {
    try {
      const schema = Joi.object({
        defaultBitrate: Joi.string().valid('64k', '128k', '192k', '96k').required()
      });
      await schema.validateAsync(req.body);
    }catch (err) {
      return res.status(500).json({ error: 'Validation Error' });
    }

    try {
      await admin.editDefaultBitrate(req.body.defaultBitrate);
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    try {
      await transcode.downloadedFFmpeg();
      res.json({});
    } catch (err) {
      console.log(err);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  mstream.get("/api/v1/admin/logs/download", async (req, res) => {
    const archive = archiver('zip');
    archive.on('error', err => {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`mstream-logs.zip`);

    //streaming magic
    archive.pipe(res);
    archive.directory(config.program.storage.logsDirectory, false)
    archive.finalize();
  });
}