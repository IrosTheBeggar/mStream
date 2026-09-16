// Discovery plug-ins — what a user may do with a network recommendation.
//
//   GET  /api/v1/discovery/plugins                 the enabled plug-ins + capabilities
//   POST /api/v1/discovery/plugins/:name/resolve   run a links/preview plug-in on one
//                                                   recommendation (body: { recommendation })
//
// Same audience as the similar routes (any signed-in user, or public mode):
// a plug-in that resolves links or previews reveals nothing about the
// library — it only re-describes a recommendation the caller already holds.
// Plug-ins that acquire files or push to external accounts get their own
// routes with their own gates (per-user allowlist, credentials) when they
// land; this file deliberately refuses to run them.
//
// Flags, never probes: the client learns whether any plug-in exists from
// /api/v1/ping's `discoveryPlugins` and only then lists them here.

import Joi from 'joi';
import winston from 'winston';
import * as plugins from '../discovery-plugins/index.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function setup(mstream) {
  mstream.get('/api/v1/discovery/plugins', (req, res) => {
    res.json({ plugins: plugins.listPlugins() });
  });

  mstream.post('/api/v1/discovery/plugins/:name/resolve', async (req, res) => {
    const name = String(req.params.name || '');
    // Unknown, disabled and malformed names all read the same: nothing to
    // resolve here. A disabled plug-in is invisible, not "forbidden".
    const plugin = NAME_RE.test(name) ? plugins.getPlugin(name) : null;
    if (!plugin || !plugins.isPluginEnabled(name)) {
      throw new WebError('unknown discovery plug-in', 404);
    }
    const resolves = plugin.capabilities.some((c) => plugins.RESOLVING_CAPABILITIES.includes(c));
    if (!resolves) {
      throw new WebError(`plug-in ${name} does not resolve recommendations`, 400);
    }

    const schema = Joi.object({ recommendation: plugins.recommendationSchema.required() });
    const { value: { recommendation } } = joiValidate(schema, req.body);

    let result;
    try {
      result = await plugin.resolve(recommendation, { user: req.user || null });
    } catch (err) {
      // A plug-in failure is the plug-in's (a catalogue is down, a parse
      // broke, its rate budget is spent) — never a server error to the
      // client, and always logged with the cause: a rejected lookup is a
      // signal worth keeping. A plug-in that set a status (429 for its
      // budget) gets it passed through; anything else is a 502.
      winston.warn(`discovery plug-in ${name} failed to resolve a recommendation: ${err.message}`);
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
      throw new WebError(status === 429
        ? `plug-in ${name} is rate-limited right now — try again shortly`
        : `plug-in ${name} could not resolve this recommendation`, status);
    }
    res.json({
      plugin: name,
      capabilities: [...plugin.capabilities],
      key: plugins.recommendationKey(recommendation),
      recommendation,
      result,
    });
  });
}
