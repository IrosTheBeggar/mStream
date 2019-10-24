const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
const mkdirp = require('make-dir');
const fs = require('fs');
const express = require('express');
const sync = require('./sync');

exports.setup = function (mstream, program) {
  mstream.post('/federation/invite/exchange', (req, res) => {
    try {
      var decodedToken = jwt.verify(req.body.token, program.secret);
    }catch(err) {
      return res.status(500).json({ error: 'Token verification failed' });
    }
    
    if (!program.users[decodedToken.username]) {
      return res.status(500).json({ error: 'User does not exist' });
    }

    if (!req.body.federationId) {
      return res.status(500).json({ error: 'Missing Federation ID' });
    }
    
    // add server's federationID into the syncThing config
    try {
      sync.addDevice(req.body.federationId, decodedToken.vPaths);
    }catch (err) {
      return res.status(403).json({ error: err.message });
    }

    res.json({});
  });

  mstream.post('/federation/invite/accept', async (req, res) => {
    if (!req.body.invite || !req.body.paths) {
      return res.status(403).json({ error: 'Missing Input Params' });
    }

    var loadJson;
    var decodedToken;

    try {
      decodedToken = jwt.decode(req.body.invite.trim());
      // Validate directories
      const xmlObj = sync.getXml();
      const idCache = {};
      const directoryCache = {};
      xmlObj.configuration.folder.forEach(f => {
        idCache[f['@_id']] = true;
        directoryCache[f['@_path']] = true;
      });

      if (sync.getId() === decodedToken.federationId) {
        throw new Error('Cannot use your own token');
      }

      Object.keys(req.body.paths).forEach(p => {
        // paths includes value not in token OR folder ID already exists. remove it
        if (!decodedToken.vPaths[p] || idCache[decodedToken.vPaths[p]]) {
          delete req.body.paths[p];
          return;
        }

        // Validate the new folder names
        if (!/^([a-z0-9 _-]{1,})$/.test(req.body.paths[p])) {
          throw new Error('Folder Name Cannot Contain Special Characters');
        }

        // Make sure folder name doesn't already exist
        if (program.folders[req.body.paths[p]]) {
          throw new Error('Folder Name Already Exists');
        }

        // Check if directory is in syncthing config
        if (directoryCache[path.join(program.federation.folder, req.body.paths[p])]) {
          throw new Error(`Directory ${p} is already federated. Choose another name`);          
        }

        // Create directory if necessary
        mkdirp.sync(path.join(program.federation.folder, req.body.paths[p]));
      });
  
      if (Object.keys(req.body.paths).length === 0) {
        throw new Error('Folders already federated');
      }

      loadJson = JSON.parse(fs.readFileSync(program.configFile, 'utf8'));
    }catch (err) {
      return res.status(403).json({ error: err.message });      
    }

    // Handle case where federationId is attached
    if (decodedToken.for) {
      if (decodedToken.for !== sync.getId()) {
        return res.status(500).json({ error: 'This token is for different Federation ID' });
      }
    } else {
      const newURL = new URL(decodedToken.url);
      newURL.pathname = '/federation/invite/exchange';

      // call server
      try {
        await axios({
          method: 'post',
          url: newURL.toString(), 
          headers: { 'accept': 'application/json' },
          responseType: 'json',
          data: { token: req.body.invite, federationId: sync.getId() }
        });
      }catch(err) {
        return res.status(500).json({message: 'Invalid Token'});
      }
    }

    try {
      Object.keys(req.body.paths).forEach(p => {
        // Add new vpaths to config file
        loadJson.folders[req.body.paths[p]] = { root: path.join(program.federation.folder, req.body.paths[p]) }
        program.folders[req.body.paths[p]] = { root: path.join(program.federation.folder, req.body.paths[p]) }
  
        // add vpath to user permissions
        loadJson.users[req.user.username].vpaths.push(req.body.paths[p]);
        program.users[req.user.username].vpaths.push(req.body.paths[p]);
  
        // Add to server
        mstream.use(`/media/${req.body.paths[p]}/`, express.static(path.join(program.federation.folder, req.body.paths[p])));
  
        // add directory to syncthing
        sync.addFederatedDirectory(req.body.paths[p], decodedToken.vPaths[p], path.join(program.federation.folder, req.body.paths[p]), decodedToken.federationId);
      });
  
      // add user to syncthing
      sync.addDevice(decodedToken.federationId, {});
    
      // Save config file
      fs.writeFileSync(program.configFile, JSON.stringify(loadJson, null, 2), 'utf8');
    }catch (err) {
      return res.status(403).json({ error: err.message });      
    }

    res.json({success: true});
  });

  mstream.post('/federation/invite/generate', (req, res) => {
    if (!program.federation || !program.federation.folder) {
      return res.status(403).json({ error: 'Invites Disabled' });
    }

    if (!req.body.paths) {
      return res.status(403).json({ error: 'Missing Input Params' });
    }

    // XOR
    if ((!req.body.url && !req.body.federationId) && !(req.body.url && req.body.federationId)) {
      return res.status(403).json({ error: 'Missing Input Params (or maybe too many?)' });      
    }

    // Verify user has access to vpaths
    if (!req.body.paths.every((currentValue) => {
      return req.user.vpaths.includes(currentValue);
    })) {
      return res.status(403).json({ error: 'Invalid Input Params' });
    }

    const pathObject = {};
    req.user.vpaths.forEach(path => {
      pathObject[path] = sync.getPathId(path);
    });

    // Setup Token Data
    const tokenData = {
      invite: true,
      federationId: sync.getId(),
      vPaths: pathObject,
      username: req.user.username
    }

    if (req.body.url) { tokenData.url = req.body.url; }
    if (req.body.federationId) {
      console.log(req.body.federationId );
      console.log(sync.getId());

      if (req.body.federationId === sync.getId()) {
        return res.status(403).json({ error: 'Cannot generate an invite for yourself' });
      }
      tokenData.for = req.body.federationId;
      // add ID to syncthing config
      try {
        sync.addDevice(req.body.federationId, pathObject);
      } catch (err) {
        return res.status(403).json({ error: 'Federation ID is incorrect length' });
      }
    }

    const options = {};
    req.body.expirationTimeInDays = Number(req.body.expirationTimeInDays);
    if (req.body.expirationTimeInDays && Number.isInteger(req.body.expirationTimeInDays) && req.body.expirationTimeInDays > 0) {
      options.expiresIn = `${req.body.expirationTimeInDays}d`;
    }

    res.json({ token: jwt.sign(tokenData, program.secret, options) });
  });

  mstream.get('/federation/stats', (req, res) => {
    res.json(sync.getXml());
  });
}
