import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { URL } from 'url';
import crypto from 'crypto';
import httpProxy from 'http-proxy';
import * as sync from '../state/syncthing.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

export function setup(mstream) {
  mstream.all('/api/v1/federation/{*path}', (req, res, next) => {
    if (config.program.federation.enabled === false) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    next();
  });

  mstream.post('/api/v1/federation/invite/accept', (req, res) => {
    const schema = Joi.object({
      url: Joi.string().uri().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      invite: Joi.string().required(),
      accessAll: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    const newURL = new URL(req.body.url);
    newURL.pathname = '/federation/invite/exchange';

    // const result = await axios({
    //   method: 'post',
    //   url: newURL.toString(),
    //   headers: { 'accept': 'application/json' },
    //   responseType: 'json',
    //   data: { token: req.body.invite, federationId: sync.getId() }
    // });

    res.json({});
  });

  mstream.post('/api/v1/federation/invite/generate', (req, res) => {
    const schema = Joi.object({
      vpaths: Joi.array().items(Joi.string()),
      url: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    const vPaths = {};
    req.body.vpaths.forEach(p => {
      if (!db.getLibraryByName(p)) { return; }
      if(typeof sync.getPathId(p) === 'string') {
        vPaths[p] = crypto.createHash('sha256').update(sync.getPathId(p)).digest('base64');
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

  // Server-side handshake endpoint. Called by a remote peer (e.g. a desktop
  // mStream instance) to request sync for a set of vpaths. The remote peer
  // must authenticate as an admin user. We add their device ID to our local
  // syncthing config (trusting them for the specified folders) and return
  // our own device ID plus the folder IDs they need to subscribe to.
  mstream.post('/api/v1/federation/accept-peer', (req, res) => {
    const schema = Joi.object({
      peerDeviceId: Joi.string().length(63).required(),
      vpaths: Joi.array().items(Joi.string()).min(1).required(),
    });
    const { value } = joiValidate(schema, req.body);

    // Validate that the user has access to every requested vpath
    const userVpaths = new Set(req.user.vpaths || []);
    for (const vp of value.vpaths) {
      if (!userVpaths.has(vp)) {
        return res.status(403).json({ error: `No access to vpath '${vp}'` });
      }
      if (!db.getLibraryByName(vp)) {
        return res.status(404).json({ error: `Unknown vpath '${vp}'` });
      }
      if (typeof sync.getPathId(vp) !== 'string') {
        return res.status(500).json({ error: `Syncthing folder not configured for '${vp}'` });
      }
    }

    // Build directories map expected by sync.addDevice()
    const directoriesMap = {};
    const folders = {};
    for (const vp of value.vpaths) {
      directoriesMap[vp] = true;
      folders[vp] = sync.getPathId(vp);
    }

    try {
      sync.addDevice(value.peerDeviceId, directoriesMap);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({
      remoteDeviceId: sync.getId(),
      folders: folders
    });
  });

  // Desktop-local endpoint. Called by the desktop UI after a successful
  // handshake with a remote server. Wires up the desktop's local syncthing
  // to subscribe to the remote's folders, optionally receive-only.
  mstream.post('/api/v1/federation/subscribe-folder', (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().required(),
      folderId: Joi.string().required(),
      remoteDeviceId: Joi.string().length(63).required(),
      localPath: Joi.string().required(),
      receiveOnly: Joi.boolean().default(true),
    });
    const { value } = joiValidate(schema, req.body);

    try {
      sync.addFederatedDirectory(
        value.vpath,
        value.folderId,
        value.localPath,
        value.remoteDeviceId,
        value.receiveOnly
      );
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({});
  });

  const apiProxy = httpProxy.createProxyServer();

  apiProxy.on('proxyReq', (proxyReq, req, _res, _options) => {
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

  mstream.all('/api/v1/syncthing-proxy/{*path}', (req, res) => {
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
