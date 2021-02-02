const winston = require('winston');
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const jukebox = require('./modules/jukebox.js');
const sharedModule = require('./src/api/shared');
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
  mstream.use(bodyParser.json()); // support json encoded bodies
  mstream.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies
  mstream.use((req, res, next) => { // CORS
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

  // Give access to public folder
  mstream.use('/public', express.static(path.join(__dirname, 'public')));
  mstream.use('/', express.static(config.program.webAppDirectory));

  // JukeBox
  jukebox.setup2(mstream, server, config.program);
  await sharedModule.setupBeforeSecurity(mstream);

  require('./src/api/auth').setup(mstream);
 
  require('./src/api/admin').setup(mstream);
  require('./src/api/db').setup(mstream);

  // Album art endpoint
  mstream.use('/album-art', express.static(config.program.storage.albumArtDirectory));
  // Download Files API
  require('./src/api/download').setup(mstream);
  // File Explorer API
  require('./src/api/file-explorer').setup(mstream);
  require('./modules/file-explorer.js').setup(mstream, config.program);
  // DB API
  require('./modules/db-read/database-public-loki.js').setup(mstream, config.program);

  // Transcoder
  transode.setup(mstream);

  // Scrobbler
  scrobbler.setup(mstream, config.program);
  // Finish setting up the jukebox and shared
  jukebox.setup(mstream, server, config.program);
  sharedModule.setupAfterSecurity(mstream);

  // TODO: Add middleware to determine if user has access to the exact file
  // Setup all folders with express static
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