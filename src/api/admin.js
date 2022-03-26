const path = require('path');
const child = require('child_process');
const os = require('os');
const Joi = require('joi');
const winston = require('winston');
const archiver = require('archiver');
const fileExplorer = require('../util/file-explorer');
const admin = require('../util/admin');
const config = require('../state/config');
const dbQueue = require('../db/task-queue');
const imageCompress = require('../db/image-compress-manager');
const transcode = require('./transcode');
const db = require('../db/manager');
const { joiValidate } = require('../util/validation');

const { getTransAlgos, getTransCodecs, getTransBitrates } = require('../api/transcode');

exports.setup = (mstream) => {
  mstream.all('/api/v1/admin/*', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    next();
  });

  mstream.post('/api/v1/admin/lock-api', async (req, res) => {
    const schema = Joi.object({ lock: Joi.boolean().required() });
    joiValidate(schema, req.body);

    await admin.lockAdminApi(req.body.lock);
    res.json({});
  });

  mstream.get('/api/v1/admin/file-explorer/win-drives', (req, res) => {
    if (os.platform() !== 'win32') {
      return res.status(400).json({});
    }

    child.exec('wmic logicaldisk get name', (error, stdout) => {
      const drives = stdout.split('\r\r\n')
        .filter(value => /[A-Za-z]:/.test(value))
        .map(value => value.trim() + '\\')
      res.json(drives);
    });
  });

  // The admin file explorer can view the entire system
  mstream.post("/api/v1/admin/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      joinDirectory: Joi.string().optional()
    });
    joiValidate(schema, req.body);

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
  });

  mstream.get("/api/v1/admin/directories", (req, res) => {
    res.json(config.program.folders);
  });

  mstream.get("/api/v1/admin/db/params", (req, res) => {
    res.json(config.program.scanOptions);
  });

  mstream.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    const schema = Joi.object({
      scanInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanInterval(req.body.scanInterval);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/save-interval", async (req, res) => {
    const schema = Joi.object({
      saveInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editSaveInterval(req.body.saveInterval);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    const schema = Joi.object({
      skipImg: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editSkipImg(req.body.skipImg);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/pause", async (req, res) => {
    const schema = Joi.object({
      pause:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editPause(req.body.pause);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    const schema = Joi.object({
      bootScanDelay:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanDelay(req.body.bootScanDelay);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/max-concurrent-scans", async (req, res) => {
    const schema = Joi.object({
      maxConcurrentTasks:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxConcurrentTasks(req.body.maxConcurrentTasks);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/compress-image", async (req, res) => {
    const schema = Joi.object({
      compressImage:  Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCompressImages(req.body.compressImage);
    res.json({});
  });

  mstream.get("/api/v1/admin/users", (req, res) => {
    // Scrub passwords
    const memClone = JSON.parse(JSON.stringify(config.program.users));
    Object.keys(memClone).forEach(key => {
      if(key === 'password' || key === 'salt') {
        delete memClone[key];
      }
    });

    res.json(memClone);
  });

  mstream.put("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      autoAccess: Joi.boolean().default(false),
      isAudioBooks: Joi.boolean().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addDirectory(
      input.value.directory,
      input.value.vpath,
      input.value.autoAccess,
      input.value.isAudioBooks,
      mstream);
    res.json({});

    try {
      dbQueue.scanVPath(input.value.vpath);
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
  });

  mstream.delete("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required()
    });
    joiValidate(schema, req.body);

    await admin.removeDirectory(req.body.vpath);
    res.json({});
  });

  mstream.put("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      admin: Joi.boolean().optional().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths
    );
    res.json({});
  });
  
  mstream.post("/api/v1/admin/db/force-compress-images", (req, res) => {
    res.json({ started: imageCompress.run() });
  });

  mstream.post("/api/v1/admin/db/scan/all", (req, res) => {
    dbQueue.scanAll();
    res.json({});
  });

  mstream.get("/api/v1/admin/db/scan/stats", (req, res) => {
    let total = 0;
    if (db.getFileCollection()) {
      for (const vpath of Object.keys(config.program.folders)) {
        total += db.getFileCollection().count({ 'vpath': vpath })
      }
    }
    
    res.json({
      fileCount: total
    });
  });

  mstream.delete("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.deleteUser(req.body.username);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserPassword(req.body.username, req.body.password);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/lastfm", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      lasftfmUser: Joi.string().required(),
      lasftfmPassword: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setUserLastFM(req.body.username, req.body.password);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/vpaths", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required()
    });
    joiValidate(schema, req.body);

    await admin.editUserVPaths(req.body.username, req.body.vpaths);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/access", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      admin: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(req.body.username, req.body.admin);
    res.json({});
  });

  mstream.get("/api/v1/admin/config", (req, res) => {
    res.json({
      address: config.program.address,
      port: config.program.port,
      noUpload: config.program.noUpload,
      writeLogs: config.program.writeLogs,
      secret: config.program.secret.slice(-4),
      ssl: config.program.ssl,
      storage: config.program.storage,
      maxRequestSize: config.program.maxRequestSize
    });
  });

  mstream.post("/api/v1/admin/config/max-request-size", async (req, res) => {
    const schema = Joi.object({
      maxRequestSize: Joi.string().pattern(/[0-9]+(KB|MB)/i).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxRequestSize(req.body.maxRequestSize);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/port", async (req, res) => {
    const schema = Joi.object({
      port: Joi.number().required()
    });
    joiValidate(schema, req.body);

    await admin.editPort(req.body.port);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/address", async (req, res) => {
    const schema = Joi.object({
      address: Joi.string().ip({ cidr: 'forbidden' }).required(),
    });
    joiValidate(schema, req.body);

    await admin.editAddress(req.body.address);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/noupload", async (req, res) => {
    const schema = Joi.object({
      noUpload: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUpload(req.body.noUpload);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/write-logs", async (req, res) => {
    const schema = Joi.object({
      writeLogs: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editWriteLogs(req.body.writeLogs);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/secret", async (req, res) => {
    const schema = Joi.object({
      strength: Joi.number().integer().positive().required()
    });
    joiValidate(schema, req.body);

    const secret = await config.asyncRandom(req.body.strength);
    await admin.editSecret(secret);
    res.json({});
  });

  mstream.get("/api/v1/admin/transcode", (req, res) => {
    const memClone = JSON.parse(JSON.stringify(config.program.transcode));
    memClone.downloaded = transcode.isDownloaded();
    res.json(memClone);
  });

  mstream.post("/api/v1/admin/transcode/enable", async (req, res) => {
    const schema = Joi.object({
      enable: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.enableTranscode(req.body.enable);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-codec", async (req, res) => {
    const schema = Joi.object({
      defaultCodec: Joi.string().valid(...getTransCodecs()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultCodec(req.body.defaultCodec);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-bitrate", async (req, res) => {
    const schema = Joi.object({
      defaultBitrate: Joi.string().valid(...getTransBitrates()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultBitrate(req.body.defaultBitrate);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-algorithm", async (req, res) => {
    const schema = Joi.object({
      algorithm: Joi.string().valid(...getTransAlgos()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultAlgorithm(req.body.algorithm);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
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

  mstream.get("/api/v1/admin/db/shared", (req, res) => {
    res.json(db.getShareCollection().find());
  });

  mstream.delete("/api/v1/admin/db/shared", (req, res) => {
    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    db.getShareCollection().findAndRemove({ 'playlistId': { '$eq': req.body.id } });
    db.saveShareDB();
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/expired", (req, res) => {
    db.getShareCollection().findAndRemove({ 'expires': { '$lt': Math.floor(Date.now() / 1000) } });
    db.saveShareDB();
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/eternal", (req, res) => {
    db.getShareCollection().findAndRemove({ 'expires': { '$eq': null } });
    db.getShareCollection().findAndRemove({ 'expires': { '$exists': false } });
    db.saveShareDB();
    res.json({});
  });

  let enableFederationDebouncer = false;
  mstream.post('/api/v1/admin/federation/enable', async (req, res) => {
    const schema = Joi.object({ enable: Joi.boolean().required() });
    joiValidate(schema, req.body);

    if (enableFederationDebouncer === true) { throw new Error('Debouncer Enabled'); }
    await admin.enableFederation(req.body.enable);
    
    enableFederationDebouncer = true;
    setTimeout(() => {
      enableFederationDebouncer = false;
    }, 5000);
    
    res.json({});
  });

  mstream.delete("/api/v1/admin/ssl", async (req, res) => {
    if (!config.program.ssl.cert) { throw new Error('No Certs'); }
    await admin.removeSSL();
    res.json({});
  });

  mstream.post("/api/v1/admin/ssl", async (req, res) => {
    const schema = Joi.object({
      cert: Joi.string().required(),
      key: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setSSL(path.resolve(req.body.cert), path.resolve(req.body.key));
    res.json({});
  });
}
