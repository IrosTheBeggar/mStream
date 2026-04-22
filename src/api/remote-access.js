import Joi from 'joi';
import * as config from '../state/config.js';
import * as remoteAccess from '../state/remote-access.js';
import * as adminUtil from '../util/admin.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const toggleSchema = Joi.object({
  enabled: Joi.boolean().required(),
  protocol: Joi.string().valid('upnp', 'nat-pmp').optional(),
  publicPort: Joi.number().integer().min(1).max(65535).optional(),
  leaseSeconds: Joi.number().integer().min(0).optional(),
});

async function persistRemoteAccess(partial) {
  const loadConfig = await adminUtil.loadFile(config.configFile);
  if (!loadConfig.remoteAccess) { loadConfig.remoteAccess = {}; }
  Object.assign(loadConfig.remoteAccess, partial);
  await adminUtil.saveFile(loadConfig, config.configFile);
  Object.assign(config.program.remoteAccess, partial);
}

let toggleInFlight = false;

export function setup(mstream) {
  mstream.get('/api/v1/admin/remote-access', (req, res) => {
    res.json(remoteAccess.getStatus());
  });

  mstream.post('/api/v1/admin/remote-access/toggle', async (req, res) => {
    if (toggleInFlight === true) {
      throw new WebError('Another remote access toggle is in progress', 409);
    }

    const { value } = joiValidate(toggleSchema, req.body);

    const patch = { enabled: value.enabled };
    if (value.protocol !== undefined) { patch.protocol = value.protocol; }
    if (value.publicPort !== undefined) { patch.publicPort = value.publicPort; }
    if (value.leaseSeconds !== undefined) { patch.leaseSeconds = value.leaseSeconds; }

    toggleInFlight = true;
    try {
      await persistRemoteAccess(patch);

      if (value.enabled === true) {
        // Tear down any existing mapping first so a protocol/port change
        // doesn't leave a stale mapping on the router.
        await remoteAccess.teardown();
        await remoteAccess.setup();
      } else {
        await remoteAccess.teardown();
      }

      res.json(remoteAccess.getStatus());
    } finally {
      toggleInFlight = false;
    }
  });
}
