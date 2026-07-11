// Admin-side federation endpoints. Extracted from admin.js to keep that file
// from accreting the federation surface — same pattern as admin-torrent.js:
// exports a `register(mstream)` function called once during admin setup, so
// every route here inherits the /api/v1/admin/* guard (admin role + network
// gate) registered before it.
//
// This module owns the credential side of federation: minting read-only keys
// scoped to selected libraries, listing/revoking them, and resetting a key's
// TOFU endpoint binding (the "friend reinstalled and has a new iroh identity"
// escape hatch). The endpoint lifecycle + ticket issuance and the peers CRUD
// arrive with the federation endpoint itself.

import Joi from 'joi';
import winston from 'winston';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';

export function register(mstream) {
  mstream.get('/api/v1/admin/federation/keys', (req, res) => {
    res.json(fedDb.getFederationKeys());
  });

  mstream.post('/api/v1/admin/federation/keys', (req, res) => {
    const schema = Joi.object({
      name: Joi.string().min(1).max(64).required(),
      vpaths: Joi.array().items(Joi.string()).min(1).unique().required(),
    });
    joiValidate(schema, req.body);

    // Resolve vpath names -> library ids up front so one unknown name fails
    // the whole mint (grants are transactional in createFederationKey too).
    const libraryIds = req.body.vpaths.map((name) => {
      const lib = db.getLibraryByName(name);
      if (!lib) { throw new WebError(`Unknown library: ${name}`, 404); }
      return lib.id;
    });

    const minted = fedDb.createFederationKey(req.body.name, libraryIds);
    winston.info(`[federation] ${req.user.username} minted key '${minted.name}' for libraries [${req.body.vpaths.join(', ')}]`);
    res.json({ id: minted.id, name: minted.name, key: minted.key });
  });

  mstream.delete('/api/v1/admin/federation/keys/:id', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.params);

    if (!fedDb.deleteFederationKey(Number(req.params.id))) {
      throw new WebError('Key not found', 404);
    }
    winston.info(`[federation] ${req.user.username} revoked key id=${req.params.id}`);
    res.json({});
  });

  mstream.post('/api/v1/admin/federation/keys/:id/reset-binding', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.params);

    if (!fedDb.resetFederationKeyBinding(Number(req.params.id))) {
      throw new WebError('Key not found', 404);
    }
    winston.info(`[federation] ${req.user.username} reset the endpoint binding on key id=${req.params.id}`);
    res.json({});
  });
}
