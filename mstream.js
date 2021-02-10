const winston = require('winston');
const express = require('express');
const fs = require('fs');
const bodyParser = require('body-parser');

const dbApi = require('./src/api/db');
const authApi = require('./src/api/auth');
const fileExplorerApi = require('./src/api/file-explorer');
const downloadApi = require('./src/api/download');
const adminApi = require('./src/api/admin')
const remoteApi = require('./src/api/remote');
const sharedApi = require('./src/api/shared');
const ddns = require('./modules/ddns');
const config = require('./src/state/config');
const logger = require('./src/logger');
const scrobbler = require('./modules/scrobbler');
const transode = require('./src/api/transcode');

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
    server = require('http').createServer();
  }

  // Magic Middleware Things
  mstream.use(bodyParser.json());
  mstream.use(bodyParser.urlencoded({ extended: true }));
  mstream.use((req, res, next) => { // CORS
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

  // Give access to public folder
  mstream.use('/', express.static(config.program.webAppDirectory));

  // Public APIs
  remoteApi.setupBeforeAuth(mstream, server);
  await sharedApi.setupBeforeSecurity(mstream);

  // Everything below this line requires authentication
  authApi.setup(mstream);
 
  adminApi.setup(mstream);
  dbApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  require('./modules/db-read/database-public-loki.js').setup(mstream, config.program);
  transode.setup(mstream);
  scrobbler.setup(mstream, config.program);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);

  // album art folder
  mstream.use('/album-art', express.static(config.program.storage.albumArtDirectory));

  // TODO: Add middleware to determine if user has access to the exact file
  Object.keys(config.program.folders).forEach( key => {
    mstream.use('/media/' + key + '/', express.static(config.program.folders[key].root));
  });

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "version": "0.1.0", "supportedVersions": ["1"] }));
  mstream.get('/api/v1', (req, res) => res.json({ "version": "0.1.0" }));

  // Start the server!
  server.on('request', mstream);
  server.listen(config.program.port, config.program.address, () => {
    const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://${config.program.address}:${config.program.port}`);

    require('./src/db/task-queue').runAfterBoot();
    ddns.setup(config.program);
  });
};

exports.reboot = async () => {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobbler.reset();
    transode.reset();
  
    // Close the server
    server.close(() => {
      this.serveIt(config.configFile);
    });
  }catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}