const jwt = require('jsonwebtoken');
const Joi = require('joi');
const URL = require('url');
// const path = require('path');
// const axios = require('axios');
// const mkdirp = require('make-dir');
// const fs = require('fs');
const winston = require('winston');
const sync = require('../state/syncthing');
const config = require('../state/config');
const { joiValidate } = require('../util/validation');
// const admin = require('../util/admin');

exports.setup = (mstream) => {
  mstream.all('/api/v1/federation/*', (req, res, next) => {
    if (config.program.federation.enabled === false) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    next();
  });

  // mstream.post('/api/v1/federation/invite/exchange', (req, res) => {
  //   try {
  //     var decodedToken = jwt.verify(req.body.token, program.secret);
  //   }catch(err) {
  //     return res.status(500).json({ error: 'Token verification failed' });
  //   }
    
  //   if (!program.users[decodedToken.username]) {
  //     return res.status(500).json({ error: 'User does not exist' });
  //   }

  //   if (!req.body.federationId) {
  //     return res.status(500).json({ error: 'Missing Federation ID' });
  //   }
    
  //   // add server's federationID into the syncThing config
  //   try {
  //     sync.addDevice(req.body.federationId, decodedToken.vPaths);
  //   }catch (err) {
  //     return res.status(403).json({ error: err.message });
  //   }

  //   res.json({});
  // });

  mstream.post('/api/v1/federation/invite/accept', async (req, res) => {
    const schema = Joi.object({
      url: Joi.string().uri().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      invite: Joi.string().required(),
      accessAll: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    const newURL = new URL(req.body.url);
    newURL.pathname = '/federation/invite/exchange';

    const result = await axios({
      method: 'post',
      url: newURL.toString(), 
      headers: { 'accept': 'application/json' },
      responseType: 'json',
      data: { token: req.body.invite, federationId: sync.getId() }
    });

      // Add Device

      // Add folders

        //   var loadJson;
  //   var decodedToken;


  //     decodedToken = jwt.decode(req.body.invite.trim());
  //     // Validate directories
  //     const xmlObj = sync.getXml();
  //     const idCache = {};
  //     const directoryCache = {};
  //     xmlObj.configuration.folder.forEach(f => {
  //       idCache[f['@_id']] = true;
  //       directoryCache[f['@_path']] = true;
  //     });

  //     Object.keys(req.body.paths).forEach(p => {
  //       // paths includes value not in token OR folder ID already exists. remove it
  //       if (!decodedToken.vPaths[p] || idCache[decodedToken.vPaths[p]]) {
  //         delete req.body.paths[p];
  //         return;
  //       }

  //       // Validate the new folder names
  //       if (!/^([a-z0-9 _-]{1,})$/.test(req.body.paths[p])) {
  //         throw new Error('Folder Name Cannot Contain Special Characters');
  //       }

  //       // Make sure folder name doesn't already exist
  //       if (program.folders[req.body.paths[p]]) {
  //         throw new Error('Folder Name Already Exists');
  //       }

  //       // Check if directory is in syncthing config
  //       if (directoryCache[path.join(program.federation.folder, req.body.paths[p])]) {
  //         throw new Error(`Directory ${p} is already federated. Choose another name`);          
  //       }

  //       // Create directory if necessary
  //       mkdirp.sync(path.join(program.federation.folder, req.body.paths[p]));
  //     });
  
  //     if (Object.keys(req.body.paths).length === 0) {
  //       throw new Error('Folders already federated');
  //     }

  //     loadJson = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));

  //     Object.keys(req.body.paths).forEach(p => {
  //       // Add new vpaths to config file
  //       loadJson.folders[req.body.paths[p]] = { root: path.join(program.federation.folder, req.body.paths[p]) }
  //       program.folders[req.body.paths[p]] = { root: path.join(program.federation.folder, req.body.paths[p]) }
  
  //       // add vpath to user permissions
  //       loadJson.users[req.user.username].vpaths.push(req.body.paths[p]);
  //       program.users[req.user.username].vpaths.push(req.body.paths[p]);
  
  //       // Add to server
  //       mstream.use(`/media/${req.body.paths[p]}/`, express.static(path.join(program.federation.folder, req.body.paths[p])));
  
  //       // add directory to syncthing
  //       sync.addFederatedDirectory(req.body.paths[p], decodedToken.vPaths[p], path.join(program.federation.folder, req.body.paths[p]), decodedToken.federationId);
  //     });
  
  //     // add user to syncthing
  //     sync.addDevice(decodedToken.federationId, {});
    
  //     // Save config file
  //     fs.writeFileSync(config.configFile, JSON.stringify(loadJson, null, 2), 'utf8');
    res.json({});
  });

  mstream.post('/api/v1/federation/invite/generate', async (req, res) => {
    const schema = Joi.object({
      vpaths: Joi.array().items(Joi.string()),
      url: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    const vPaths = {};
    req.body.vpaths.forEach(p => {
      if (!config.program.folders[p]) { return; }
      if(typeof sync.getPathId(p) === 'string') {
        vPaths[p] = require('crypto').createHash('sha256').update(sync.getPathId(p)).digest('base64');
      }
    });

    // Setup Token Data
    const tokenData = {
      federationInvite: true,
      vPaths: vPaths,
      username: req.user.username
    };

    if(typeof req.body.url === 'string') {
      tokenData.url = req.body.url;
    }

    res.json({ token: jwt.sign(tokenData, config.program.secret, {}) });
  });

  mstream.get('/api/v1/federation/stats', (req, res) => {
    res.json({
      deviceId: sync.getId(),
      uiAddress: sync.getUiAddress()
    });
  });

  const apiProxy = require('http-proxy').createProxyServer();

  apiProxy.on('proxyReq', (proxyReq, req, res, options) => {
    proxyReq.path = proxyReq.path.replace('/api/v1/syncthing-proxy', '');

    if (proxyReq.path.charAt(0) !== '/') {
      proxyReq.path = '/' + proxyReq.path;
    }

    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      // incase if content-type is application/x-www-form-urlencoded -> we need to change to application/json
      proxyReq.setHeader('Content-Type','application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      // stream the content
      proxyReq.write(bodyData);
    }
  });

  apiProxy.on('error', (err, req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong. And we are reporting a custom error message.');
  });

  mstream.all('/api/v1/syncthing-proxy/*', (req, res) => {
    // Add the auth token as a cookie so all contents of the iframe use it
    if (req.token) { res.cookie('x-access-token', req.token); }
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true});
  });

  mstream.all('/api/v1/syncthing-proxy/', (req, res) => {
    // Add the auth token as a cookie so all contents of the iframe use it
    if (req.token) { res.cookie('x-access-token', req.token); }
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true});
  });
}
