import winston from 'winston';
import express from 'express';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';
import { createRequire } from 'module';

import * as dbApi from './api/db.js';
import * as playlistApi from './api/playlist.js';
import * as authApi from './api/auth.js';
import * as fileExplorerApi from './api/file-explorer.js';
import * as downloadApi from './api/download.js';
import * as adminApi from './api/admin.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as syncthing from './state/syncthing.js';
import * as federationApi from './api/federation.js';
import * as scannerApi from './api/scanner.js';
import WebError from './util/web-error.js';
import { sanitizeFilename } from './util/validation.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

let mstream;
let server;

export async function serveIt(configFile) {
  mstream = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    process.exit(1);
  }

  // Logging
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory);
  }

  // Set server
  if (config.program.ssl && config.program.ssl.cert && config.program.ssl.key) {
    try {
      config.setIsHttps(true);
      server = https.createServer({
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert),
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    config.setIsHttps(false);
    server = http.createServer();
  }

  // Magic Middleware Things
  mstream.use(cookieParser());
  mstream.use(express.json({ limit: config.program.maxRequestSize }));
  mstream.use(express.urlencoded({ extended: true }));
  mstream.use((req, res, next) => {
    // CORS
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
  });

  // Setup DB
  await dbManager.initDB();

  // remove trailing slashes, needed for relative URLs on the webapp
  mstream.get('{*path}', (req, res, next) => {
    // check if theres more than one slash at the end of the URL
    if (req.path.endsWith('//')) {
      // find all trailing slashes at the end of the url
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString =
        req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(
        302,
        req.path.slice(0, (matchEnd[0].length - 1) * -1) + queryString
      );
    }
    next();
  });

  // Block access to admin page if necessary
  mstream.get('/admin', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    if (Object.keys(config.program.users).length === 0) {
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch (_err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/admin/index.html', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    next();
  });

  mstream.get('/', (req, res, next) => {
    if (Object.keys(config.program.users).length === 0) {
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch (_err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/login', (req, res, next) => {
    if (Object.keys(config.program.users).length === 0) {
      return res.redirect(302, '..');
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      return res.redirect(302, '..');
    } catch (_err) {
      next();
    }
  });

  // Give access to public folder
  mstream.use('/', express.static(config.program.webAppDirectory));

  // Public APIs
  remoteApi.setupBeforeAuth(mstream, server);
  await sharedApi.setupBeforeSecurity(mstream);

  // Everything below this line requires authentication
  authApi.setup(mstream);

  scannerApi.setup(mstream);
  adminApi.setup(mstream);
  dbApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transcode.setup(mstream);
  scrobblerApi.setup(mstream);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  syncthing.setup();
  federationApi.setup(mstream);

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "server": packageJson.version, "apiVersions": ["1"] }));

  // album art folder
  mstream.get('/album-art/:file', (req, res) => {
    if (!req.params.file) {
      throw new WebError('Missing Error', 404);
    }

    // ideally we should be checking this filename against a DB entry
    const filename = sanitizeFilename(req.params.file);

    const compressedFilePath = path.join(config.program.storage.albumArtDirectory, `z${req.query.compress}-${filename}`);
    if (req.query.compress && fs.existsSync(compressedFilePath)) {
      return res.sendFile(compressedFilePath);
    }

    res.sendFile(path.join(config.program.storage.albumArtDirectory, filename));
  });

  // TODO: determine if user has access to the exact file
  // mstream.all('/media/*', (req, res, next) => {
  //   next();
  // });

  Object.keys(config.program.folders).forEach(key => {
    mstream.use(
      '/media/' + key + '/',
      express.static(config.program.folders[key].root)
    );
  });

  // error handling
  mstream.use((error, req, res, _next) => {
    winston.error(`Server error on route ${req.originalUrl}`, { stack: error });

    // Check for validation error
    if (error instanceof Joi.ValidationError) {
      return res.status(403).json({ error: error.message });
    }

    if (error instanceof WebError) {
      return res.status(error.status).json({ error: error.message });
    }

    res.status(500).json({ error: 'Server Error' });
  });

  // Start the server!
  server.on('request', mstream);
  server.listen(config.program.port, config.program.address, async () => {
    const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);

    const taskQueue = await import('./db/task-queue.js');
    taskQueue.runAfterBoot();
  });
}

export function reboot() {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();

    if (config.program.federation.enabled === false) {
      syncthing.kill2();
    }

    // Close the server
    server.close(() => {
      serveIt(config.configFile);
    });
  } catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
