const winston = require('winston');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

require('./util/async-error');

const dbApi = require('./api/db');
const playlistApi = require('./api/playlist');
const authApi = require('./api/auth');
const fileExplorerApi = require('./api/file-explorer');
const downloadApi = require('./api/download');
const adminApi = require('./api/admin')
const remoteApi = require('./api/remote');
const sharedApi = require('./api/shared');
const scrobblerApi = require('./api/scrobbler');
const config = require('./state/config');
const logger = require('./logger');
const transode = require('./api/transcode');
const dbManager = require('./db/manager');
const syncthing = require('./state/syncthing');
const federationApi = require('./api/federation');
const scannerApi = require('./api/scanner');
const WebError = require('./util/web-error');

let mstream;
let server;

exports.serveIt = async configFile => {
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
      server = require('https').createServer({
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert)
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    config.setIsHttps(false);
    server = require('http').createServer();
  }

  // Magic Middleware Things
  mstream.use(cookieParser());
  mstream.use(express.json({ limit: config.program.maxRequestSize }));
  mstream.use(express.urlencoded({ extended: true }));
  mstream.use((req, res, next) => { // CORS
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

  // Setup DB
  dbManager.initLoki();

  // remove trailing slashes, needed for relative URLs on the webapp
  mstream.get('*', (req, res, next) => {
    // check if theres more than one slash at the end of the URL
    if (req.path.endsWith('//')) {
      // find all trailing slashes at the end of the url
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString = req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(302, req.path.slice(0, (matchEnd[0].length - 1)*-1) + queryString);
    }
    next();
  });

  // Block access to admin page if necessary
  mstream.get('/admin', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.send('<p>Admin Page Disabled</p>'); }
    if (Object.keys(config.program.users).length === 0){
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch(err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/admin/index.html', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.send('<p>Admin Page Disabled</p>'); }
    next();
  });

  mstream.get('/', (req, res, next) => {
    if (Object.keys(config.program.users).length === 0){
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch(err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/login', (req, res, next) => {
    if (Object.keys(config.program.users).length === 0){
      return res.redirect(302, '..');
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      return res.redirect(302, '..');
    } catch(err) {
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
 
  scannerApi.setup(mstream)
  adminApi.setup(mstream);
  dbApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transode.setup(mstream);
  scrobblerApi.setup(mstream);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  syncthing.setup();
  federationApi.setup(mstream);

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "server": require('../package.json').version, "apiVersions": ["1"] }));

  // album art folder
  mstream.get('/album-art/:file', (req, res) => {
    if (!req.params.file) { throw new WebError('Missing Error', 404); }

    if (req.query.compress && fs.existsSync(path.join(config.program.storage.albumArtDirectory, `z${req.query.compress}-${req.params.file}`))) {
      return res.sendFile(path.join(config.program.storage.albumArtDirectory, `z${req.query.compress}-${req.params.file}`));
    }

    res.sendFile(path.join(config.program.storage.albumArtDirectory, req.params.file));
  });

  // TODO: determine if user has access to the exact file
  // mstream.all('/media/*', (req, res, next) => {
  //   next();
  // });

  Object.keys(config.program.folders).forEach( key => {
    mstream.use('/media/' + key + '/', express.static(config.program.folders[key].root));
  });

  // error handling
  mstream.use((error, req, res, next) => {
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
  server.listen(config.program.port, config.program.address, () => {
    const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);

    require('./db/task-queue').runAfterBoot();
  });
};

exports.reboot = async () => {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transode.reset();

    if (config.program.federation.enabled === false) {
      syncthing.kill();
    }
  
    // Close the server
    server.close(() => {
      this.serveIt(config.configFile);
    });
  }catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}