import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { URL } from 'url';
import crypto from 'crypto';
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

  // FEDERATION UNWIRED: the /api/v1/syncthing-proxy/* routes reverse-proxied to
  // Syncthing's local Web GUI via http-proxy (createProxyServer + apiProxy.web
  // to http://sync.getUiAddress()). http-proxy has been removed from the
  // dependency tree, so these routes are not registered here. Re-add a proxy
  // mechanism when federation/syncthing is revived (see src/server.js).
}
