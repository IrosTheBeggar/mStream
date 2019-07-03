const winston = require('winston');
const jwt = require('jsonwebtoken');
const loki = require('lokijs');
const path = require('path');
const axios = require('axios');
const mkdirp = require('make-dir');

const dbName = 'federation.loki-v1.db'

// TODO: Sync Library

exports.setup = function (mstream, program) {
  const federationDB = new loki(path.join(program.storage.dbDirectory, dbName));
  var federationLogs;
  var federatedDirectories;
  
  federationDB.loadDatabase({}, err => {
    federationLogs = federationDB.getCollection('logs');
    if (federationLogs === null) {
      federationLogs = federationDB.addCollection("logs");
    }

    federatedDirectories = federationDB.getCollection('directories');
    if (federatedDirectories === null) {
      federatedDirectories = federationDB.addCollection("directories");
    }
  });

  mstream.post('/federation/invite/exchange', (req, res) => {
    try {
      var decodedToken = jwt.verify(req.body.token, program.secret);
    }catch(err) {
      return res.status(500).json({ error: 'Token verification failed' });
    }
    
    // generate new token
    const tokenData = {
      federation: true,
      vPaths: decodedToken.vPaths,
      from: decodedToken.from
    }

    const token = jwt.sign(tokenData, program.secret);

    // TODO: add it to logs
    
    res.json({token: token});
  });

  mstream.post('/federation/invite/accept', async (req, res) => {
    if (!req.body.invite || !req.body.folderName) {
      return res.status(403).json({ error: 'Missing Input Params' });
    }

    if (typeof program.configFile !== 'string') {
      return res.status(500).json({ error: 'mStream can only be federated when booting with a config' });
    }

    // Validate the new folder name
    if (!/^([a-z0-9 _-]{1,})$/.test(req.body.folderName)) {
      return res.status(500).json({ error: 'Folder Name Cannot Contain Special Characters' });
    }

    // Make sure folder name doesn't already exist
    if (program.folders[req.body.folderName]) {
      return res.status(500).json({ error: 'Folder Name Already Exists' });
    }

    if (!program.federation || !program.federation.folder) {
      return res.status(500).json({ error: 'Federation not configured' });
    }

    const decodedToken = jwt.decode(req.body.invite);
    const newURL = new URL(decodedToken.url);
    newURL.pathname = '/federation/invite/exchange';

    // call server
    try {
      var response = await axios({
        method: 'post',
        url: newURL.toString(), 
        headers: { 'accept': 'application/json' },
        responseType: 'json',
        data: { token: req.body.invite }
      });
    }catch(err) {
      return es.status(500).json({message: 'Invalid Token'});
    }

    // Load JSON config file
    // TODO: we should ideally not have to load the json file every time we want to edit it
    var loadJson;
    try {
      if (fs.statSync(configFile).isFile()) {
        loadJson = JSON.parse(fs.readFileSync(program.configFile, 'utf8'));
      }
    } catch(error) {
      console.log('Could not load config file');
    }

    // Check if directory exists
    if (!fs.existsSync(fe.join(program.federation.folder, req.body.folderName))) {
      return es.status(500).json({message: 'Directory already exists'});
    }

    // Make Directory
    try {
      mkdirp.sync(fe.join(program.federation.folder, req.body.folderName));
    }catch(err) {
      return es.status(500).json({message: 'Could not create directory'});
    }

    // TODO:
    // save returned token to DB

    // Add new vpaths to config file
    loadJson.folders[req.body.folderName] = { root: fe.join(program.federation.folder, req.body.folderName) }
    program.folders[req.body.folderName] = { root: fe.join(program.federation.folder, req.body.folderName) }

    // add vpath to user permissions
    loadJson.users[req.user.username].vpaths.push(req.body.folderName);
    program.users[req.user.username].vpaths.push(req.body.folderName);

    // Add to server
    mstream.use('/media/' + req.body.folderName + '/', express.static(fe.join(program.federation.folder, req.body.folderName)));

    // Save config file
    fs.writeFileSync(configFile, JSON.stringify(loadJson), 'utf8');

    // TODO: Kick off sync process 

    res.json({success: true});
  });

  mstream.post('/federation/invite/generate', (req, res) => {
    if(program.federation && program.federation.disableInvites) {
      return res.status(403).json({ error: 'Invites Disabled' });
    }

    if(!req.body.paths || !req.body.url) {
      return res.status(403).json({ error: 'Missing Input Params' });
    }

    // Verify user has access to vpaths
    if(!req.body.paths.every((currentValue) => {
      return req.user.vpaths.includes(currentValue);
    })) {
      return res.status(403).json({ error: 'Invalid Input Params' });
    }

    // Setup Token Data
    const tokenData = {
      invite: true,
      url: req.body.url,
      vPaths: req.user.vpaths,
      from: req.user.username
    }

    const options = {};
    req.body.expirationTimeInDays = Number(req.body.expirationTimeInDays);
    if (req.body.expirationTimeInDays && Number.isInteger(req.body.expirationTimeInDays) && req.body.expirationTimeInDays > 0) {
      options.expiresIn = `${req.body.expirationTimeInDays}d`;
    }

    // Return Token and ID
    res.json({token: jwt.sign(tokenData, program.secret, options)});
  });
}
