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
import * as logger from '../logger.js';
import { joiValidate } from '../util/validation.js';
import { bootRustPlayer, killRustPlayer, proxyToRust, getActiveBackend, getDetectedCliPlayers, refreshDetectedCliPlayers } from './server-playback.js';
import { listImplementedMethods, methodStatusTable } from './subsonic/index.js';
import * as lyricsLrclib from './lyrics-lrclib.js';
import { listTokenAuthAttempts, clearTokenAuthAttempts, generateApiKey } from './subsonic/auth.js';
import * as nowPlaying from './subsonic/now-playing.js';
// Torrent admin endpoints live in their own module — see
// admin-torrent.js. We call adminTorrent.register(mstream) from
// setup() below, after the admin guard is registered, so the torrent
// routes inherit the same auth checks as every other /admin/* path.
import * as adminTorrent from './admin-torrent.js';

import { getTransCodecs, getTransBitrates } from '../api/transcode.js';

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
      result[lib.name] = {
        // Numeric library id, exposed so admin UI flows that need to
        // address libraries by id (e.g. /api/v1/admin/backup/* — the
        // backup module joins on libraries.id) can avoid a second
        // lookup. Existing consumers ignore unknown fields.
        id: lib.id,
        root: lib.root_path,
        type: lib.type,
        // V21: per-library boolean. Admin panel renders a simple
        // on/off toggle; default false matches the Rust scanner.
        followSymlinks: lib.follow_symlinks === 1,
      };
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

  mstream.post("/api/v1/admin/db/params/compress-image", async (req, res) => {
    const schema = Joi.object({
      compressImage:  Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCompressImages(req.body.compressImage);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/scan-commit-interval", async (req, res) => {
    // Mirrors the soft cap in src/state/config.js's Joi schema —
    // clamp+warn to 1000 instead of 400-rejecting. Same reasoning as
    // there: a typo in an admin slider shouldn't take the API down,
    // and the warning makes it visible in logs. We pass `value` (the
    // post-clamp number) to the persister so the stored config matches
    // the running config, not whatever oversized number the request
    // body originally carried.
    const schema = Joi.object({
      scanCommitInterval: Joi.number().integer().min(1).required().custom((value) => {
        if (value > 1000) {
          winston.warn(`scanCommitInterval=${value} from admin POST exceeds 1000 cap; clamping to 1000`);
          return 1000;
        }
        return value;
      })
    });
    const { value } = joiValidate(schema, req.body);

    await admin.editScanCommitInterval(value.scanCommitInterval);
    res.json({});
  });

  // 0 = auto (Rust scanner picks half the available cores). Operators
  // who want to push harder during a known-quiet maintenance window
  // can set N explicitly; pinning to 1 keeps the legacy single-
  // threaded behaviour. Only the Rust scanner honours this — the JS
  // fallback ignores the field, see src/db/scanner.mjs.
  mstream.post("/api/v1/admin/db/params/scan-threads", async (req, res) => {
    const schema = Joi.object({
      scanThreads: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanThreads(req.body.scanThreads);
    res.json({});
  });

  // Toggle inline waveform generation during scans. true (default) =
  // scanner decodes and writes <hash>.bin files (instant playback
  // bar, ~90% of scan wall-time). false = scanner skips the decode
  // entirely; the on-demand /api/v1/db/waveform endpoint regenerates
  // via ffmpeg on first playback. ~10× scan speedup at the cost of
  // a few hundred ms latency on first waveform request per track.
  mstream.post("/api/v1/admin/db/params/generate-waveforms", async (req, res) => {
    const schema = Joi.object({
      generateWaveforms: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editGenerateWaveforms(req.body.generateWaveforms);
    res.json({});
  });

  // Toggle stratum-dsp BPM + musical-key detection during scans.
  // true (default) = Rust scanner runs analyze_audio over the same
  // mono PCM buffer it decodes for the waveform, populating
  // tracks.bpm / tracks.musical_key / tracks.bpm_source='stratum'
  // for files without tag-sourced values. false = scanner only
  // ingests tag-sourced BPM/key, leaves the rest NULL. Tag-sourced
  // tracks always skip stratum regardless of this flag — toggling
  // off doesn't suddenly overwrite a TBPM tag's value.
  // Rust-only — JS fallback scanner accepts the field but doesn't
  // run analysis (no stratum-dsp port). To backfill on existing
  // libraries, trigger a force-rescan after enabling.
  mstream.post("/api/v1/admin/db/params/analyze-bpm", async (req, res) => {
    const schema = Joi.object({
      analyzeBpm: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeBpm(req.body.analyzeBpm);
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
        allowFileModify: user.allow_file_modify === 1,
        allowServerAudio: user.allow_server_audio === 1,
        // V37: whitelist flag for the optional torrent-client feature.
        // Only consulted by request handlers when
        // config.torrent.enabledFor === 'whitelist'; in 'all' mode this
        // is informational only.
        allowTorrent: user.allow_torrent === 1
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

  // V21: per-library followSymlinks flag. Takes effect on the next
  // scan of this library.
  mstream.post('/api/v1/admin/directory/follow-symlinks', async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      followSymlinks: Joi.boolean().required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    await admin.setLibraryFollowSymlinks(value.vpath, value.followSymlinks);
    res.json({});
  });

  mstream.put("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      admin: Joi.boolean().optional().default(false),
      allowMkdir: Joi.boolean().optional().default(true),
      allowUpload: Joi.boolean().optional().default(true),
      // Server-audio access is opt-in per user — admins always bypass
      // the gate in server-playback.js, everyone else must be granted
      // explicitly via the admin panel.
      allowServerAudio: Joi.boolean().optional().default(false),
      // Optional opt-in Subsonic-specific password (V35). When provided,
      // it's stored AES-encrypted alongside the PBKDF2 main password.
      // Without it, the user can still log in via Subsonic apiKey or
      // by setting a Subsonic password later via the mobile-clients
      // panel; only token-auth Subsonic clients require it.
      subsonicPassword: Joi.string().min(1).optional(),
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths,
      input.value.allowMkdir,
      input.value.allowUpload,
      input.value.allowServerAudio
    );
    if (input.value.subsonicPassword) {
      await admin.setSubsonicPassword(input.value.username, input.value.subsonicPassword);
    }
    res.json({});
  });

  // Update an existing user's Subsonic password (admin-side; the
  // user-side equivalent is PUT /api/v1/user/subsonic-password).
  // Admin can already change the main PBKDF2 password via the sibling
  // POST /api/v1/admin/users/password — exposing the same capability
  // for the Subsonic-specific column is consistent and avoids forcing
  // admins through an "ask the user to set their own" loop. Pass
  // `password: null` to clear the column.
  mstream.post("/api/v1/admin/users/subsonic-password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().min(1).allow(null).required(),
    });
    joiValidate(schema, req.body);
    await admin.setSubsonicPassword(req.body.username, req.body.password);
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
      allowFileModify: Joi.boolean().optional().default(true),
      // Opt-in per user. A PATCH that doesn't name allowServerAudio
      // leaves the user without access — clients that want to update
      // only one field must read the current value first and echo it.
      allowServerAudio: Joi.boolean().optional().default(false)
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(
      req.body.username,
      req.body.admin,
      req.body.allowMkdir,
      req.body.allowUpload,
      req.body.allowFileModify,
      req.body.allowServerAudio
    );
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
      logBufferSize: config.program.logBufferSize,
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
      // Keep this list in sync with state/config.js `ui` validator.
      ui: Joi.string().valid('default', 'velvet', 'subsonic').required()
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

  // Keep the bounds in sync with the logBufferSize validator in
  // state/config.js (0 = disabled, 10000 = hard cap).
  mstream.post("/api/v1/admin/config/log-buffer-size", async (req, res) => {
    const schema = Joi.object({
      logBufferSize: Joi.number().integer().min(0).max(10000).required()
    });
    joiValidate(schema, req.body);

    await admin.editLogBufferSize(req.body.logBufferSize);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/auto-boot-server-audio", async (req, res) => {
    const schema = Joi.object({
      autoBootServerAudio: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAutoBootServerAudio(req.body.autoBootServerAudio);

    // Flag controls Rust preference now. Either way, re-boot server audio so
    // the active backend matches the new setting:
    //   true  → kill current backend, boot Rust (with CLI fallback)
    //   false → kill current backend, boot CLI directly (MPD preferred)
    killRustPlayer();
    await bootRustPlayer();

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

  mstream.get("/api/v1/admin/server-audio/info", (req, res) => {
    const active = getActiveBackend();
    res.json({
      backend: active.backend,
      player: active.player,
      detectedCliPlayers: getDetectedCliPlayers(),
    });
  });

  // Re-run the CLI player detection probe. Use this after installing or
  // removing a player (mpv, vlc, mplayer, or an MPD daemon) without having
  // to restart the server.
  mstream.post("/api/v1/admin/server-audio/detect", async (req, res) => {
    const detected = await refreshDetectedCliPlayers();
    res.json({ detectedCliPlayers: detected });
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

  mstream.post("/api/v1/admin/transcode/auto-update", async (req, res) => {
    const schema = Joi.object({
      autoUpdate: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAutoUpdate(req.body.autoUpdate);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
  });

  // Live-log viewer feed. Returns recent entries from the in-memory ring
  // buffer (logger.js) so the admin panel can poll a tail without touching
  // disk — works even when writeLogs is off. `since` is the highest seq the
  // client already has; the server returns newer entries plus the current
  // `lastSeq` cursor and the buffer `capacity`.
  mstream.get("/api/v1/admin/logs/recent", (req, res) => {
    res.json(logger.getRecentLogs(req.query.since));
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

  // Stub: federation toggle is unavailable while the feature is being
  // rebuilt around the new local-backup story (see src/server.js for
  // why the syncthing+federation modules are no longer wired up). The
  // route stays mounted so old admin clients hitting it get a clear,
  // structured "feature is disabled" response instead of a 404 that
  // they might mistake for a transient routing issue. The original
  // implementation is preserved below — restore it (and the
  // enableFederation helper in src/util/admin.js, plus the syncthing
  // import in src/server.js) when federation comes back.
  mstream.post('/api/v1/admin/federation/enable', (req, res) => {
    res.status(410).json({
      error: 'Federation is being rebuilt and is currently unavailable. See the Federation tab for status.',
    });
  });
  // let enableFederationDebouncer = false;
  // mstream.post('/api/v1/admin/federation/enable', async (req, res) => {
  //   const schema = Joi.object({ enable: Joi.boolean().required() });
  //   joiValidate(schema, req.body);
  //
  //   if (enableFederationDebouncer === true) { throw new Error('Debouncer Enabled'); }
  //   await admin.enableFederation(req.body.enable);
  //
  //   enableFederationDebouncer = true;
  //   setTimeout(() => {
  //     enableFederationDebouncer = false;
  //   }, 5000);
  //
  //   res.json({});
  // });

  mstream.delete("/api/v1/admin/ssl", async (req, res) => {
    if (!config.program.ssl.cert) { throw new Error('No Certs'); }
    await admin.removeSSL();
    res.json({});
  });

  mstream.get('/api/v1/admin/dlna', (req, res) => {
    res.json({
      mode:   config.program.dlna.mode,
      port:   config.program.dlna.port,
      name:   config.program.dlna.name,
      uuid:   config.program.dlna.uuid,
      browse: config.program.dlna.browse,
    });
  });

  mstream.post('/api/v1/admin/dlna/browse', async (req, res) => {
    const schema = Joi.object({
      browse: Joi.string().valid('flat', 'dirs', 'artist', 'album', 'genre').required(),
    });
    const input = joiValidate(schema, req.body);
    await admin.editDlnaBrowse(input.value.browse);
    res.json({});
  });

  let dlnaDebouncer = false;
  mstream.post('/api/v1/admin/dlna/mode', async (req, res) => {
    const schema = Joi.object({
      mode: Joi.string().valid('disabled', 'same-port', 'separate-port').required(),
      port: Joi.number().integer().min(1).max(65535).optional(),
    });
    const input = joiValidate(schema, req.body);

    if (dlnaDebouncer === true) { throw new Error('Debouncer Enabled'); }
    await admin.enableDlna(input.value.mode, input.value.port);

    dlnaDebouncer = true;
    setTimeout(() => { dlnaDebouncer = false; }, 2000);

    res.json({});
  });

  // ── Subsonic ────────────────────────────────────────────────────────────

  mstream.get('/api/v1/admin/subsonic', (req, res) => {
    res.json({
      mode: config.program.subsonic.mode,
      port: config.program.subsonic.port,
    });
  });

  let subsonicDebouncer = false;
  mstream.post('/api/v1/admin/subsonic/mode', async (req, res) => {
    const schema = Joi.object({
      mode: Joi.string().valid('disabled', 'same-port', 'separate-port').required(),
      port: Joi.number().integer().min(1).max(65535).optional(),
    });
    const input = joiValidate(schema, req.body);

    if (subsonicDebouncer === true) { throw new Error('Debouncer Enabled'); }

    // Guard against breaking the bundled Subsonic UI: if the operator
    // runs ui='subsonic' and tries to move Subsonic off same-port,
    // the Refix SPA can no longer reach /rest/*. Return a clear 403
    // instead of silently breaking the UI — the admin can either
    // switch the UI first or pick same-port.
    if (config.program.ui === 'subsonic' && input.value.mode !== 'same-port') {
      return res.status(403).json({
        error: "Cannot change Subsonic mode while ui='subsonic': the bundled Refix client " +
               "requires Subsonic on the same origin. Switch `ui` to 'default' or 'velvet' first.",
      });
    }

    await admin.enableSubsonic(input.value.mode, input.value.port);

    subsonicDebouncer = true;
    setTimeout(() => { subsonicDebouncer = false; }, 2000);

    res.json({});
  });

  // ── Subsonic admin-panel data endpoints ─────────────────────────────────
  // Backs the Subsonic admin UI widgets: method-count card, now-playing
  // strip, jukebox status, token-auth warnings. All admin-only (guarded
  // by the /api/v1/admin/* middleware at the top of this file).

  // Methods + now-playing snapshot, for the main status card.
  mstream.get('/api/v1/admin/subsonic/stats', (req, res) => {
    const methods = listImplementedMethods();
    const methodStatuses = methodStatusTable();
    const fullCount = methodStatuses.filter(m => m.status === 'full').length;
    const stubCount = methodStatuses.length - fullCount;
    // Join now-playing entries to tracks so the admin UI can render
    // readable "who's listening to what" rows without re-resolving.
    const snap = nowPlaying.snapshot();
    const byUserTrack = snap.map(s => {
      const row = db.getDB().prepare(`
        SELECT t.title, ar.name AS artist, al.name AS album
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums  al ON al.id = t.album_id
        WHERE t.id = ?
      `).get(s.trackId);
      return {
        username:   s.username,
        trackId:    s.trackId,
        title:      row?.title || null,
        artist:     row?.artist || null,
        album:      row?.album || null,
        sinceMs:    Date.now() - s.since,
      };
    });
    // V20: lyrics cache stats (LRCLib fallback). Always emitted so
    // older admin UIs see it; shown only when config.lyrics.lrclib
    // is true (UI gates the render).
    const lyricsCfg   = config.program.lyrics || {};
    const lyricsCache = lyricsLrclib.cacheStats();

    res.json({
      methodsImplemented: methods.length,
      methods,
      // [{name, status: 'full' | 'stub'}] — lets the admin card show
      // Full vs Stub badges next to each name. Older admin UIs just
      // look at `methods` and ignore this.
      methodStatuses,
      fullCount,
      stubCount,
      nowPlaying: byUserTrack,
      lyrics: {
        lrclibEnabled:       !!lyricsCfg.lrclib,
        writeSidecarEnabled: !!lyricsCfg.writeSidecar,
        cache:               lyricsCache,
      },
    });
  });

  // V20: lyrics-cache management. Admin-only (guarded by the /admin/*
  // middleware). Two purge modes:
  //   - full  → drop every row (useful after disabling LRCLib or
  //             after a big tag-cleanup pass)
  //   - retry → drop just 'error' + 'pending' rows (shakes loose a
  //             network-outage window without losing hits)
  mstream.post('/api/v1/admin/subsonic/lyrics-cache/purge', (req, res) => {
    // Match the Joi validation style the rest of /admin uses — a
    // malformed body (extra keys, wrong `mode` string) throws to the
    // 403 handler rather than silently proceeding with defaults.
    const schema = Joi.object({
      mode: Joi.string().valid('full', 'retry').default('full'),
    });
    const { value } = joiValidate(schema, req.body || {});
    const removed = value.mode === 'retry'
      ? lyricsLrclib.purgeTransient()
      : lyricsLrclib.purgeAll();
    res.json({ removed, mode: value.mode });
  });

  // V20: toggle the LRCLib fallback. Persists to the config file so
  // the change survives a restart. Does NOT purge the cache — a
  // previous hit stays valid whether or not fetching is enabled; the
  // toggle only gates NEW fetches.
  mstream.post('/api/v1/admin/subsonic/lyrics-cache/enabled', async (req, res) => {
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    const { value } = joiValidate(schema, req.body || {});
    const loadConfig = await admin.loadFile(config.configFile);
    loadConfig.lyrics = { ...(loadConfig.lyrics || {}), lrclib: value.enabled };
    await admin.saveFile(loadConfig, config.configFile);
    const wasEnabled = !!config.program.lyrics?.lrclib;
    config.program.lyrics = { ...(config.program.lyrics || {}), lrclib: value.enabled };
    // On transition to disabled, drop queued-but-not-yet-running
    // jobs so no new HTTP traffic goes to lrclib.net. In-flight
    // jobs complete (their request is already out) but won't start
    // new ones — see drain()'s isEnabled check.
    let cancelled = 0;
    if (wasEnabled && !value.enabled) {
      cancelled = lyricsLrclib.cancelQueuedJobs();
    }
    res.json({ enabled: value.enabled, cancelledJobs: cancelled });
  });

  // Toggle the writeSidecar option. Mirrors the lrclib toggle above —
  // persisted to config.json, flipped in-memory immediately. Has no
  // effect on already-cached rows (they live in SQLite either way);
  // only gates future write-through to the filesystem.
  mstream.post('/api/v1/admin/subsonic/lyrics-cache/write-sidecar', async (req, res) => {
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    const { value } = joiValidate(schema, req.body || {});
    const loadConfig = await admin.loadFile(config.configFile);
    loadConfig.lyrics = { ...(loadConfig.lyrics || {}), writeSidecar: value.enabled };
    await admin.saveFile(loadConfig, config.configFile);
    config.program.lyrics = { ...(config.program.lyrics || {}), writeSidecar: value.enabled };
    res.json({ writeSidecar: value.enabled });
  });

  // Ping-the-Subsonic-endpoint probe for the "test connection" button.
  // Hits our own /rest/ping using an ephemeral internal call so we exercise
  // the real auth + response path rather than short-circuiting.
  mstream.get('/api/v1/admin/subsonic/test', async (req, res) => {
    // Use the HTTP port the Subsonic handler is actually mounted on — same
    // port when mode=same-port, separate when mode=separate-port.
    const subMode = config.program.subsonic.mode;
    if (subMode === 'disabled') {
      return res.json({ ok: false, reason: 'Subsonic API is disabled' });
    }
    const port = subMode === 'separate-port' ? config.program.subsonic.port : config.program.port;
    const host = config.program.address === '0.0.0.0' ? '127.0.0.1' : config.program.address;
    try {
      // Admin user already has a JWT; mint a throwaway API key for this
      // probe so we don't need to thread the admin's plaintext password.
      const key = generateApiKey(req.user.id, `admin-probe-${Date.now()}`);
      const url = `http://${host}:${port}/rest/ping?f=json&apiKey=${encodeURIComponent(key)}`;
      const start = Date.now();
      const r = await fetch(url);
      const body = await r.json();
      const ms = Date.now() - start;
      const envelope = body['subsonic-response'];
      // Revoke the probe key immediately — single-use.
      db.getDB().prepare('DELETE FROM user_api_keys WHERE key = ?').run(key);
      res.json({
        ok:      envelope?.status === 'ok',
        status:  envelope?.status || 'unknown',
        version: envelope?.version,
        serverVersion: envelope?.serverVersion,
        latencyMs: ms,
        url,
      });
    } catch (err) {
      res.json({ ok: false, reason: err.message || 'test failed' });
    }
  });

  // Live jukebox status (via rust-server-audio). Returns a normalised
  // envelope so the admin UI can render "not available", "idle",
  // "playing X" without having to probe multiple endpoints.
  mstream.get('/api/v1/admin/subsonic/jukebox', async (req, res) => {
    if (!config.program.autoBootServerAudio) {
      return res.json({ available: false, reason: 'autoBootServerAudio is disabled' });
    }
    try {
      const { data: status } = await proxyToRust('GET', '/status');
      const { data: queue } = await proxyToRust('GET', '/queue');
      res.json({
        available:   true,
        playing:     !!status?.playing,
        paused:      !!status?.paused,
        position:    status?.position || 0,
        duration:    status?.duration || 0,
        volume:      status?.volume ?? 1.0,
        currentFile: status?.file || '',
        queueLength: Array.isArray(queue?.queue) ? queue.queue.length : 0,
        queueIndex:  status?.queue_index ?? 0,
        shuffle:     !!status?.shuffle,
        loopMode:    status?.loop_mode || 'none',
      });
    } catch (err) {
      res.json({ available: false, reason: err.message });
    }
  });

  // Recent token-auth failures. Real-world Subsonic clients often default
  // to token auth and get stuck in a "wrong credentials" loop; surfacing
  // these lets admins see who's affected and act fast.
  mstream.get('/api/v1/admin/subsonic/token-auth-attempts', (req, res) => {
    res.json({ attempts: listTokenAuthAttempts() });
  });

  mstream.delete('/api/v1/admin/subsonic/token-auth-attempts', (req, res) => {
    clearTokenAuthAttempts();
    res.json({});
  });

  // Admin-mints-key-for-another-user. Return value includes the plaintext
  // key exactly once so the admin can copy-paste it to the end user.
  mstream.post('/api/v1/admin/subsonic/mint-key', (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      name:     Joi.string().trim().min(1).max(100).required(),
    });
    const { value } = joiValidate(schema, req.body);
    const user = db.getUserByUsername(value.username);
    if (!user) { return res.status(404).json({ error: `User '${value.username}' not found` }); }
    const key = generateApiKey(user.id, value.name);
    res.json({ key, name: value.name, username: value.username });
  });

  // All torrent admin endpoints live in admin-torrent.js — registered
  // inside the same admin-guard scope as everything else in this
  // file, so they inherit the lockAdmin / admin-only checks at the
  // top of this function.
  adminTorrent.register(mstream);


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
