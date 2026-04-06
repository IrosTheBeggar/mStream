import path from 'path';
import child from 'child_process';
import os from 'os';
import Joi from 'joi';
import winston from 'winston';
import archiver from 'archiver';
import * as fileExplorer from '../util/file-explorer.js';
import * as admin from '../util/admin.js';
import * as config from '../state/config.js';
import * as dbQueue from '../db/task-queue.js';
import * as imageCompress from '../db/image-compress-manager.js';
import * as transcode from './transcode.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { bootRustPlayer, killRustPlayer } from './server-playback.js';

import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';

export function setup(mstream) {
  mstream.all('/api/v1/admin/{*path}', (req, res, next) => {
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
      thisDirectory = os.homedir();
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
    const libraries = db.getAllLibraries();
    const result = {};
    for (const lib of libraries) {
      result[lib.name] = { root: lib.root_path, type: lib.type };
    }
    res.json(result);
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

  mstream.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    const schema = Joi.object({
      skipImg: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editSkipImg(req.body.skipImg);
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

  mstream.post("/api/v1/admin/db/params/scan-batch-size", async (req, res) => {
    const schema = Joi.object({
      scanBatchSize: Joi.number().integer().min(1).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanBatchSize(req.body.scanBatchSize);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/auto-album-art", async (req, res) => {
    const schema = Joi.object({ autoAlbumArt: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAutoAlbumArt(req.body.autoAlbumArt);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-write-to-folder", async (req, res) => {
    const schema = Joi.object({ albumArtWriteToFolder: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAlbumArtWriteToFolder(req.body.albumArtWriteToFolder);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-write-to-file", async (req, res) => {
    const schema = Joi.object({ albumArtWriteToFile: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAlbumArtWriteToFile(req.body.albumArtWriteToFile);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-services", async (req, res) => {
    const schema = Joi.object({
      albumArtServices: Joi.array().items(
        Joi.string().valid('musicbrainz', 'itunes', 'deezer')
      ).required()
    });
    joiValidate(schema, req.body);
    await admin.editAlbumArtServices(req.body.albumArtServices);
    res.json({});
  });

  mstream.get("/api/v1/admin/users", (req, res) => {
    const users = db.getAllUsers();
    const result = {};
    for (const user of users) {
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      result[user.username] = {
        admin: user.is_admin === 1,
        vpaths: libraries.map(l => l.name),
        allowMkdir: user.allow_mkdir === 1,
        allowUpload: user.allow_upload === 1,
        allowFileModify: user.allow_file_modify === 1
      };
    }
    res.json(result);
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
      if (dbQueue.isSubdirectoryOfExistingVpath(input.value.directory)) {
        winston.info(`Skipping scan for '${input.value.vpath}' — directory is a subdirectory of an existing vpath`);
      } else {
        dbQueue.scanVPath(input.value.vpath);
      }
    } catch (err) {
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
      admin: Joi.boolean().optional().default(false),
      allowMkdir: Joi.boolean().optional().default(true),
      allowUpload: Joi.boolean().optional().default(true)
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths,
      input.value.allowMkdir,
      input.value.allowUpload
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

  mstream.post("/api/v1/admin/db/scan/force-rescan", (req, res) => {
    dbQueue.rescanAll();
    res.json({});
  });

  mstream.get("/api/v1/admin/db/scan/stats", (req, res) => {
    const d = db.getDB();
    const row = d ? d.prepare('SELECT COUNT(*) AS total FROM tracks').get() : { total: 0 };
    res.json({ fileCount: row.total });
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
      admin: Joi.boolean().required(),
      allowMkdir: Joi.boolean().required(),
      allowUpload: Joi.boolean().required(),
      allowFileModify: Joi.boolean().optional().default(true)
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(req.body.username, req.body.admin, req.body.allowMkdir, req.body.allowUpload, req.body.allowFileModify);
    res.json({});
  });

  mstream.get("/api/v1/admin/config", (req, res) => {
    res.json({
      address: config.program.address,
      port: config.program.port,
      noUpload: config.program.noUpload,
      noMkdir: config.program.noMkdir,
      noFileModify: config.program.noFileModify,
      writeLogs: config.program.writeLogs,
      secret: config.program.secret.slice(-4),
      ssl: config.program.ssl,
      storage: config.program.storage,
      maxRequestSize: config.program.maxRequestSize,
      autoBootServerAudio: config.program.autoBootServerAudio,
      rustPlayerPort: config.program.rustPlayerPort,
      ui: config.program.ui || 'default'
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

  mstream.post("/api/v1/admin/config/ui", async (req, res) => {
    const schema = Joi.object({
      ui: Joi.string().valid('default', 'velvet').required()
    });
    joiValidate(schema, req.body);

    await admin.editUI(req.body.ui);
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

  mstream.post("/api/v1/admin/config/nomkdir", async (req, res) => {
    const schema = Joi.object({
      noMkdir: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editMkdir(req.body.noMkdir);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/nofilemodify", async (req, res) => {
    const schema = Joi.object({
      noFileModify: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editFileModify(req.body.noFileModify);
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

  mstream.post("/api/v1/admin/config/auto-boot-server-audio", async (req, res) => {
    const schema = Joi.object({
      autoBootServerAudio: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAutoBootServerAudio(req.body.autoBootServerAudio);

    // Start or stop the Rust player immediately
    if (req.body.autoBootServerAudio) {
      bootRustPlayer();
    } else {
      killRustPlayer();
    }

    res.json({});
  });

  mstream.post("/api/v1/admin/config/rust-player-port", async (req, res) => {
    const schema = Joi.object({
      rustPlayerPort: Joi.number().integer().min(1).max(65535).required()
    });
    joiValidate(schema, req.body);

    await admin.editRustPlayerPort(req.body.rustPlayerPort);
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

  // default-algorithm endpoint removed — streaming is now the only mode

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
  });

  mstream.get("/api/v1/admin/logs/download", (req, res) => {
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
    const d = db.getDB();
    res.json(d.prepare('SELECT * FROM shared_playlists').all());
  });

  mstream.delete("/api/v1/admin/db/shared", (req, res) => {
    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    db.getDB().prepare('DELETE FROM shared_playlists WHERE share_id = ?').run(req.body.id);
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/expired", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    db.getDB().prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(now);
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/eternal", (req, res) => {
    db.getDB().prepare('DELETE FROM shared_playlists WHERE expires IS NULL').run();
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
