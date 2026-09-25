// The collection destination — where the files a plug-in brings in are put
// (src/discovery-plugins/destination.js): collection copies from a paired
// peer, and "Get it" downloads.
//
//   GET /api/v1/discovery/collection/destination   the effective destination + what the picker needs
//   PUT /api/v1/discovery/collection/destination   { destination: { vpath, base, layout } | null }
//
// One per user, shared by every acquire plug-in. `null` goes back to the
// library default. In public mode the anonymous account keeps the one
// shared setting.

import Joi from 'joi';
import * as destination from '../discovery-plugins/destination.js';
import { refuseJukebox } from './discovery-plugin-jobs.js';
import { joiValidate } from '../util/validation.js';

export function setup(mstream) {
  mstream.use('/api/v1/discovery/collection', refuseJukebox);

  mstream.get('/api/v1/discovery/collection/destination', (req, res) => {
    res.json(destination.describeDestination(req.user));
  });

  mstream.put('/api/v1/discovery/collection/destination', (req, res) => {
    const { value } = joiValidate(Joi.object({
      destination: destination.destinationSchema.allow(null).required(),
    }), req.body);
    destination.saveDestination(req.user, value.destination);
    res.json(destination.describeDestination(req.user));
  });
}
