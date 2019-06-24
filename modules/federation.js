const winston = require('winston');
const jwt = require('jsonwebtoken');
const loki = require('lokijs');
const path = require('path');
const axios = require('axios');

const dbName = 'federation.loki-v1.db'

// TODO: Automatically delete expired shared invites
// TODO: check for updates daily

exports.setup = function (mstream, program) {
  const federationDB = new loki(path.join(program.storage.dbDirectory, dbName));
  var inviteCollection;
  var federationLogs;
  var federatedDirectories;
  
  federationDB.loadDatabase({}, err => {
    inviteCollection = federationDB.getCollection('invites');
    if (inviteCollection === null) {
      inviteCollection = federationDB.addCollection("invites");
    }

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
    const decodedToken = jwt.decode(req.body.token);

    // TODO: Check if it's in the database and not taken already
    
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
    if(!req.body.invite) {
      return res.status(403).json({ error: 'Missing Input Params' });
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
      res.status(500).json({message: 'Invalid Token'});
    }

    console.log(response.data)

    // TODO:
        // save returned token to DB
        // Add new vpaths to config file
        // add vpath to user permissions
        // Kick off sync process

    res.json({success: true});
  });

  mstream.post('/federation/invite/generate', (req, res) => {
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

    const token = jwt.sign(tokenData, program.secret, { expiresIn: '14d' });

    // Save to DB
    inviteCollection.insert({token: token, used: false, void:false});
    federationDB.saveDatabase(err => {
      if (err) {
        winston.error(`DB Save Error : ${err}`);
      }
    });

    // Return Token and ID
    res.json({token: token});
  });
}
