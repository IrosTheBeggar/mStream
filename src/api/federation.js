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

  // NOTE: these proxy routes used to set an `x-access-token` cookie so the
  // embedded Syncthing iframe's own sub-requests (which can't add headers)
  // carried auth. That cookie-set was removed as part of the cookie-removal
  // effort. Federation/Syncthing is currently disabled anyway
  // (federationApi.setup is commented out in src/server.js), so this is
  // inert; if the syncthing proxy is ever revived it will need a
  // non-cookie auth scheme for the iframe (e.g. a one-time token in the
  // iframe src that the proxy exchanges server-side).
  mstream.all('/api/v1/syncthing-proxy/{*path}', (req, res) => {
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true});
  });

  mstream.all('/api/v1/syncthing-proxy/', (req, res) => {
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true});
  });
}
