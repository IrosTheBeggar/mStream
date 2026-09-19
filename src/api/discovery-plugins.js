// Discovery plug-ins — what a user may do with a network recommendation.
//
//   GET  /api/v1/discovery/plugins                 the enabled plug-ins + capabilities, and
//                                                   whether the caller may start jobs
//   POST /api/v1/discovery/plugins/:name/resolve   run a links/preview plug-in on one
//                                                   recommendation (body: { recommendation })
//   GET  /api/v1/discovery/plugins/:name/settings  the caller's settings for a plug-in
//   PUT  /api/v1/discovery/plugins/:name/settings  store one ({ key, value }; null deletes)
//
// Same audience as the similar routes (any signed-in user, or public mode):
// a plug-in that resolves links or previews reveals nothing about the
// library — it only re-describes a recommendation the caller already holds.
// Plug-ins that acquire files or push to external accounts run as jobs
// (src/api/discovery-plugin-jobs.js) behind their own gate.
//
// Settings are per user (user_settings, V74, namespace
// discovery-plugin:<name>): a plug-in declares what may be stored
// (`userSettings`, a Joi schema per key, `secret` for tokens), checks the
// meaning (`validateSetting`) and describes the effective view
// (`describeSettings` — e.g. the copy destination with its defaults filled
// in). Secrets never leave with a value; the view says only that one is set.
//
// Flags, never probes: the client learns whether any plug-in exists from
// /api/v1/ping's `discoveryPlugins` and only then lists them here.

import Joi from 'joi';
import winston from 'winston';
import * as plugins from '../discovery-plugins/index.js';
import * as settingsDb from '../db/user-settings.js';
import { jobsAllowed } from './discovery-plugin-jobs.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function enabledPlugin(name) {
  // Unknown, disabled and malformed names all read the same: nothing here.
  // A disabled plug-in is invisible, not "forbidden".
  const plugin = NAME_RE.test(name) ? plugins.getPlugin(name) : null;
  if (!plugin || !plugins.isPluginEnabled(name)) {
    throw new WebError('unknown discovery plug-in', 404);
  }
  return plugin;
}

export function settingsNamespace(name) { return `discovery-plugin:${name}`; }

// The settings owner: a real user's id, or the anonymous sentinel's in
// public mode (auth.js pins req.user to it, so a no-users server keeps one
// shared set). A caller with no id at all (a federation key's synthetic
// user) has nowhere to keep settings.
function settingsUserId(req) {
  const id = req.user ? req.user.id : null;
  if (!Number.isInteger(id) || id <= 0) { throw new WebError('plug-in settings need a user account', 403); }
  return id;
}

async function settingsView(plugin, req, userId) {
  const ns = settingsNamespace(plugin.name);
  const settings = {};
  for (const row of settingsDb.describeUserSettings(userId, ns)) {
    settings[row.key] = row.secret
      ? { secret: true, set: true, updatedAt: row.updatedAt }
      : { value: row.value, updatedAt: row.updatedAt };
  }
  const view = plugin.describeSettings
    ? await plugin.describeSettings({ user: req.user, stored: settingsDb.getUserSettings(userId, ns) })
    : {};
  return { plugin: plugin.name, keys: Object.keys(plugin.userSettings), settings, ...view };
}

export function setup(mstream) {
  mstream.get('/api/v1/discovery/plugins', (req, res) => {
    // `jobs.allowed` is the acquisition gate for THIS caller: a client hides
    // the acquire / hand-off rows instead of offering a button that answers 403.
    res.json({ plugins: plugins.listPlugins(), jobs: { allowed: jobsAllowed(req.user) } });
  });

  mstream.get('/api/v1/discovery/plugins/:name/settings', async (req, res) => {
    const plugin = enabledPlugin(String(req.params.name || ''));
    if (!plugin.userSettings) { throw new WebError(`plug-in ${plugin.name} has no settings`, 400); }
    res.json(await settingsView(plugin, req, settingsUserId(req)));
  });

  mstream.put('/api/v1/discovery/plugins/:name/settings', async (req, res) => {
    const plugin = enabledPlugin(String(req.params.name || ''));
    if (!plugin.userSettings) { throw new WebError(`plug-in ${plugin.name} has no settings`, 400); }
    const userId = settingsUserId(req);
    const { value: { key, value } } = joiValidate(Joi.object({
      key: Joi.string().valid(...Object.keys(plugin.userSettings)).required(),
      value: Joi.any().required(),
    }), req.body);
    const spec = plugin.userSettings[key];
    const ns = settingsNamespace(plugin.name);
    if (value === null) {
      settingsDb.deleteUserSetting(userId, ns, key);
    } else {
      const checked = spec.schema.validate(value, { abortEarly: false, stripUnknown: true });
      if (checked.error) { throw new WebError(`setting ${key}: ${checked.error.message}`, 400); }
      if (plugin.validateSetting) { await plugin.validateSetting(key, checked.value, { user: req.user }); }
      settingsDb.setUserSetting(userId, ns, key, checked.value, { secret: spec.secret === true });
    }
    res.json(await settingsView(plugin, req, userId));
  });

  mstream.post('/api/v1/discovery/plugins/:name/resolve', async (req, res) => {
    const name = String(req.params.name || '');
    const plugin = enabledPlugin(name);
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
