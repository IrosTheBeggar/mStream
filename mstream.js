const logger = require('./src/logger');
logger.init();
const winston = require('winston');
const express = require('express');
const mstream = express();
const fs = require('fs');
const bodyParser = require('body-parser');

const dbModule = require('./modules/db-management/database-master.js');
const jukebox = require('./modules/jukebox.js');
const sync = require('./modules/sync.js');
const sharedModule = require('./modules/shared.js');
const defaults = require('./modules/defaults.js');
const ddns = require('./modules/ddns');
const federation = require('./modules/federation');

exports.serveIt = config => {
  try {
    var program = defaults.setup(config);
    require('./src/global').setup(program);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    process.exit(1);
  }

  // Logging
  if (program.writeLogs) {
    logger.addFileLogger(program.storage.logsDirectory);
  }

  // Set server
  var server;
  if (program.ssl && program.ssl.cert && program.ssl.key) {
    try {
      server = require('https').createServer({
        key: fs.readFileSync(program.ssl.key),
        cert: fs.readFileSync(program.ssl.cert)
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

  if (program.newWebApp) {
    mstream.use(express.static( 'webapp-beta' ));
  } else {
    // Give access to public folder
    mstream.use('/public', express.static( program.webAppDirectory ));
    // Serve the webapp
    mstream.get('/', (req, res) => {
      res.sendFile('mstream.html', { root: program.webAppDirectory });
    });
    // Serve Shared Page
    mstream.all('/shared/playlist/*', (req, res) => {
      res.sendFile('shared.html', { root: program.webAppDirectory });
    });
    // Serve Jukebox Page
    mstream.all('/remote', (req, res) => {
      res.sendFile('remote.html', { root: program.webAppDirectory });
    });
    // Admin Panel
    mstream.all('/admin', (req, res) => {
      res.sendFile('admin.html', { root: program.webAppDirectory });
    });
  }

  // JukeBox
  jukebox.setup2(mstream, server, program);
  // Shared
  sharedModule.setupBeforeSecurity(mstream, program);

  require('./src/api/auth.js').setup(mstream, program);
 
  require('./src/api/admin.js').setup(mstream, program);

  // Album art endpoint
  mstream.use('/album-art', express.static(program.storage.albumArtDirectory));
  // Download Files API
  require('./modules/download.js').setup(mstream);
  // File Explorer API
  require('./src/api/file-explorer.js').setup(mstream, program);
  require('./modules/file-explorer.js').setup(mstream, program);
  // Load database
  dbModule.setup(mstream, program);
  if (program.federation && program.federation.folder) {
    federation.setup(mstream, program);
    sync.setup(program);
  }
  // Transcoder
  if (program.transcode && program.transcode.enabled === true) {
    require("./modules/ffmpeg.js").setup(mstream, program);
  }
  // Scrobbler
  require('./modules/scrobbler.js').setup(mstream, program);
  // Finish setting up the jukebox and shared
  jukebox.setup(mstream, server, program);
  sharedModule.setupAfterSecurity(mstream, program);

  // TODO: Add middleware to determine if user has access to the exact file
  // Setup all folders with express static
  Object.keys(program.folders).forEach( key => {
    mstream.use('/media/' + key + '/', express.static(program.folders[key].root));
  });

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "version": "0.1.0", "supportedVersions": ["1"] }));
  mstream.get('/api/v1', (req, res) => res.json({ "version": "0.1.0" }));

  // Start the server!
  server.on('request', mstream);
  server.listen(program.port, program.address, () => {
    const protocol = program.ssl && program.ssl.cert && program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://${program.address}:${program.port}`);

    dbModule.runAfterBoot(program);
    ddns.setup(program);
  });
};
