const winston = require('winston');
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const jukebox = require('./modules/jukebox.js');
const sharedModule = require('./modules/shared.js');
const ddns = require('./modules/ddns');
const config = require('./src/state/config');
const logger = require('./src/logger');
const scrobbler = require('./modules/scrobbler');

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
  mstream.use('/public', express.static( config.program.webAppDirectory ));
  mstream.use('/', express.static(path.join(__dirname, 'webapp')));
  // Serve the webapp
  mstream.get('/', (req, res) => {
    res.sendFile('mstream.html', { root: config.program.webAppDirectory });
  });
  // Serve Shared Page
  mstream.all('/shared/playlist/*', (req, res) => {
    res.sendFile('shared.html', { root: config.program.webAppDirectory });
  });
  // Serve Jukebox Page
  mstream.all('/remote', (req, res) => {
    res.sendFile('remote.html', { root: config.program.webAppDirectory });
  });

  // JukeBox
  jukebox.setup2(mstream, server, config.program);
  // Shared
  sharedModule.setupBeforeSecurity(mstream, config.program);

  require('./src/api/auth.js').setup(mstream);
 
  require('./src/api/admin.js').setup(mstream);
  require('./src/api/db.js').setup(mstream);

  // Album art endpoint
  mstream.use('/album-art', express.static(config.program.storage.albumArtDirectory));
  // Download Files API
  require('./modules/download.js').setup(mstream);
  // File Explorer API
  require('./src/api/file-explorer.js').setup(mstream);
  require('./modules/file-explorer.js').setup(mstream, config.program);
  // DB API
  require('./modules/db-read/database-public-loki.js').setup(mstream, config.program);

  // Transcoder
  if (config.program.transcode && config.program.transcode.enabled === true) {
    require("./modules/ffmpeg.js").setup(mstream, config.program);
  }
  // Scrobbler
  scrobbler.setup(mstream, config.program);
  // Finish setting up the jukebox and shared
  jukebox.setup(mstream, server, config.program);
  sharedModule.setupAfterSecurity(mstream, config.program);

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
  
    // Close the server
    server.close(() => {
      this.serveIt(config.configFile);
    });
  }catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}