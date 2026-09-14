// Discovery plug-in registry.
//
// A plug-in is "something a user can DO with a recommendation" — a recording
// the discovery network suggested that this library does not have. The
// base behaviour used to be a clipboard copy; plug-ins replace that with
// links, previews, acquisitions and hand-offs to services the user already
// uses. The registry is the one place that knows which exist, which are
// switched on, and what each can do; the API (src/api/discovery-plugins.js)
// and the feature flags (src/api/server-info.js) read from here and never
// from the plug-ins directly.
//
// Contract — a plug-in is a frozen object:
//
//   {
//     name:         'links'              // [a-z0-9-], stable: config key + URL segment
//     title:        'Open elsewhere'     // for the UI's action menu
//     description:  '…'                  // one sentence, for the admin panel
//     capabilities: ['links']            // subset of CAPABILITIES (below)
//     scope:        'server'             // 'server' = admin config only;
//                                        // 'user'   = needs per-user credentials
//     resolve(rec, ctx)                  // links / preview: -> Promise<result>
//   }
//
// Capabilities say which verbs the UI may offer and which API routes apply:
//   links    resolve() returns { links: [{ id, label, url, kind }] }
//   preview  resolve() returns { preview: { url, seconds, provider, … } | null }
//            — a short clip from a catalogue, or null when it has no match
//   play     resolve() returns { play: { url, kind, … } | null } — a
//            full-length stream THIS server can serve for the recommendation
//            (a paired peer's track through the federation proxy)
//   acquire  (later) starts a job that lands a file in the scratch library
//   handoff  (later) pushes the recommendation to an external account
//
// Enablement lives in config.program.discoveryPlugins[name].enabled — the
// Joi schema in src/state/config.js declares every built-in explicitly (a
// plug-in with no config entry is OFF), and the admin API flips the flag
// live. Tests pass their own config object instead of touching program.

import * as config from '../state/config.js';

export const CAPABILITIES = Object.freeze({
  LINKS: 'links',
  PREVIEW: 'preview',
  PLAY: 'play',
  ACQUIRE: 'acquire',
  HANDOFF: 'handoff',
});

// The capabilities answered by resolve() — the others start jobs.
export const RESOLVING_CAPABILITIES = Object.freeze([
  CAPABILITIES.LINKS, CAPABILITIES.PREVIEW, CAPABILITIES.PLAY,
]);

export const SCOPES = Object.freeze({ SERVER: 'server', USER: 'user' });

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const plugins = new Map();

export function registerPlugin(def) {
  if (!def || typeof def !== 'object') { throw new Error('registerPlugin: a plug-in definition object is required'); }
  if (!NAME_RE.test(def.name || '')) { throw new Error(`registerPlugin: invalid plug-in name ${JSON.stringify(def.name)}`); }
  if (plugins.has(def.name)) { throw new Error(`registerPlugin: ${def.name} is already registered`); }
  if (typeof def.title !== 'string' || !def.title) { throw new Error(`registerPlugin: ${def.name} needs a title`); }
  if (!Array.isArray(def.capabilities) || def.capabilities.length === 0
    || !def.capabilities.every((c) => Object.values(CAPABILITIES).includes(c))) {
    throw new Error(`registerPlugin: ${def.name} declares unknown capabilities ${JSON.stringify(def.capabilities)}`);
  }
  if (!Object.values(SCOPES).includes(def.scope)) { throw new Error(`registerPlugin: ${def.name} needs a scope`); }
  const resolves = def.capabilities.some((c) => RESOLVING_CAPABILITIES.includes(c));
  if (resolves && typeof def.resolve !== 'function') { throw new Error(`registerPlugin: ${def.name} must implement resolve()`); }
  const frozen = Object.freeze({ description: '', ...def, capabilities: Object.freeze([...def.capabilities]) });
  plugins.set(frozen.name, frozen);
  return frozen;
}

export function getPlugin(name) {
  return (typeof name === 'string' && plugins.get(name)) || null;
}

function pluginsConfig(explicit) {
  if (explicit) { return explicit; }
  return (config.program && config.program.discoveryPlugins) || {};
}

// A plug-in is enabled only when its config entry says so — an unknown or
// missing entry is OFF, so a plug-in that ships before its config does can
// never switch itself on.
export function isPluginEnabled(name, { config: cfg } = {}) {
  if (!plugins.has(name)) { return false; }
  const entry = pluginsConfig(cfg)[name];
  return !!(entry && entry.enabled === true);
}

// The client-facing view: what a user may do here. Enabled only unless the
// caller (the admin panel) asks for everything.
export function listPlugins({ includeDisabled = false, config: cfg } = {}) {
  const out = [];
  for (const p of plugins.values()) {
    const enabled = isPluginEnabled(p.name, { config: cfg });
    if (!enabled && !includeDisabled) { continue; }
    out.push({
      name: p.name, title: p.title, description: p.description,
      capabilities: [...p.capabilities], scope: p.scope, enabled,
    });
  }
  return out;
}

export function anyPluginEnabled(opts = {}) {
  for (const name of plugins.keys()) { if (isPluginEnabled(name, opts)) { return true; } }
  return false;
}

export function pluginNames() {
  return [...plugins.keys()];
}

// Tests register throwaway plug-ins; nothing in the server calls this.
export function unregisterPluginForTests(name) {
  plugins.delete(name);
}
