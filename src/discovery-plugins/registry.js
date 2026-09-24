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
//   acquire  starts a job that lands a file in the user's collection
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

// The capabilities that run as jobs (src/discovery-plugins/jobs.js): the
// plug-in implements `run(ctx)` and may declare `concurrency` (default 1).
export const RUNNABLE_CAPABILITIES = Object.freeze([
  CAPABILITIES.ACQUIRE, CAPABILITIES.HANDOFF,
]);

export const SCOPES = Object.freeze({ SERVER: 'server', USER: 'user' });

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Same key rule as src/db/user-settings.js — a key the store would refuse
// must not pass registration.
const SETTING_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

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
  const runnable = def.capabilities.some((c) => RUNNABLE_CAPABILITIES.includes(c));
  if (runnable && typeof def.run !== 'function') { throw new Error(`registerPlugin: ${def.name} must implement run(ctx)`); }
  if (def.concurrency !== undefined && !(Number.isInteger(def.concurrency) && def.concurrency > 0)) {
    throw new Error(`registerPlugin: ${def.name} concurrency must be a positive integer`);
  }
  // Per-user settings (user_settings, namespace discovery-plugin:<name>):
  //   userSettings: { <key>: { schema: Joi, secret?: bool } }   what may be stored
  //   validateSetting(key, value, { user })                     semantic checks; throws
  //   describeSettings({ user, stored })                        the effective view
  // The routes in src/api/discovery-plugins.js read these; a plug-in
  // without `userSettings` has no settings routes.
  if (def.userSettings !== undefined) {
    if (!def.userSettings || typeof def.userSettings !== 'object' || Array.isArray(def.userSettings)) {
      throw new Error(`registerPlugin: ${def.name} userSettings must be an object of key -> { schema }`);
    }
    for (const [key, spec] of Object.entries(def.userSettings)) {
      if (!SETTING_KEY_RE.test(key)) { throw new Error(`registerPlugin: ${def.name} has an invalid setting key ${JSON.stringify(key)}`); }
      if (!spec || typeof spec !== 'object' || !spec.schema || typeof spec.schema.validate !== 'function') {
        throw new Error(`registerPlugin: ${def.name} setting ${key} needs a Joi schema`);
      }
    }
  }
  for (const hook of ['validateSetting', 'describeSettings', 'probe']) {
    if (def[hook] !== undefined && typeof def[hook] !== 'function') {
      throw new Error(`registerPlugin: ${def.name} ${hook} must be a function`);
    }
  }
  // What the ADMIN panel edits (src/api/admin.js):
  //   adminSettings  the keys of config.discoveryPlugins.<name> an admin may
  //                  edit (never `enabled` — that is the switch)
  if (def.adminSettings !== undefined) {
    if (!Array.isArray(def.adminSettings) || !def.adminSettings.every((k) => typeof k === 'string' && SETTING_KEY_RE.test(k) && k !== 'enabled')) {
      throw new Error(`registerPlugin: ${def.name} adminSettings must be a list of config keys (not "enabled")`);
    }
  }
  const frozen = Object.freeze({
    description: '', ...def,
    capabilities: Object.freeze([...def.capabilities]),
    adminSettings: Object.freeze([...(def.adminSettings || [])]),
  });
  plugins.set(frozen.name, frozen);
  return frozen;
}

// ── Availability probes ───────────────────────────────────────────────────
// A plug-in that needs something outside this process (a binary, a daemon)
// declares `probe({ settings? })` → { ok, reason, detail? } (`detail` = what
// it found, e.g. a version, for the admin panel; `settings` = config values
// to try INSTEAD of the saved ones). An enabled plug-in whose probe fails
// is treated as absent — not listed, its routes answer 404 — so an
// unconfigured plug-in never shows a row that cannot work (the cards'
// "hidden, never locked" rule). Results are cached and refreshed in the
// background; until the first probe answers, a plug-in counts as available.
// A passing probe is trusted for a minute; a failing one is retried sooner,
// so a binary installed (or ffmpeg finishing its bootstrap) shows up fast.
const PROBE_TTL_MS = 60_000;
const PROBE_FAIL_TTL_MS = 5_000;
const probes = new Map();
const probeTtl = (s) => (s && s.ok === false ? PROBE_FAIL_TTL_MS : PROBE_TTL_MS);

async function runProbe(p, opts) {
  try {
    const r = await p.probe(opts || {});
    return {
      ok: !(r && r.ok === false),
      reason: r && r.reason ? String(r.reason) : null,
      detail: r && r.detail && typeof r.detail === 'object' ? r.detail : null,
    };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err), detail: null };
  }
}

export async function refreshProbes({ force = false } = {}) {
  const now = Date.now();
  await Promise.all([...plugins.values()].filter((p) => typeof p.probe === 'function').map(async (p) => {
    const cur = probes.get(p.name);
    if (!force && cur && now - cur.at < probeTtl(cur)) { return; }
    probes.set(p.name, { ...(await runProbe(p)), at: Date.now() });
  }));
}

export function probeStatus(name) {
  const s = probes.get(name);
  return s ? { ok: s.ok, reason: s.reason, detail: s.detail || null } : null;
}

// Probe ONE plug-in now (the admin panel's "check again" and its settings
// modal's Test). Without `settings` the answer replaces the cached one, so
// the user listing follows at once. With `settings` it is a dry run against
// values that are not saved: the cache is left alone. A plug-in without a
// probe is always available. null = no such plug-in.
export async function probePlugin(name, { settings } = {}) {
  const p = plugins.get(name);
  if (!p) { return null; }
  if (typeof p.probe !== 'function') { return { ok: true, reason: null, detail: null }; }
  const dryRun = settings && typeof settings === 'object';
  const result = await runProbe(p, dryRun ? { settings } : {});
  if (!dryRun) { probes.set(name, { ...result, at: Date.now() }); }
  return result;
}

// Saved settings changed: what the last probe saw may no longer be true.
export function forgetProbe(name) {
  probes.delete(name);
}

// true only when a probe ran and failed. A stale or missing probe kicks a
// refresh in the background and answers "available" meanwhile.
export function isPluginUnavailable(name) {
  const p = plugins.get(name);
  if (!p || typeof p.probe !== 'function') { return false; }
  const s = probes.get(name);
  if (!s || Date.now() - s.at >= probeTtl(s)) { refreshProbes().catch(() => {}); }
  return !!(s && s.ok === false);
}

// The plug-ins the job runner drives (registration order).
export function runnablePlugins() {
  return [...plugins.values()].filter((p) => p.capabilities.some((c) => RUNNABLE_CAPABILITIES.includes(c)));
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
    const unavailable = isPluginUnavailable(p.name);
    if (unavailable && !includeDisabled) { continue; }
    const row = {
      name: p.name, title: p.title, description: p.description,
      capabilities: [...p.capabilities], scope: p.scope, enabled,
      // The keys a client may read and write through the settings routes.
      settings: p.userSettings ? Object.keys(p.userSettings) : [],
      // false only when the plug-in's probe failed (admin listing only —
      // the user listing simply omits it).
      available: !unavailable,
    };
    if (includeDisabled) {
      const status = probeStatus(p.name);
      row.reason = status && !status.ok ? status.reason : null;
      // Admin-only facts: what the probe found, and which config keys the
      // panel may edit.
      row.detail = status ? status.detail : null;
      row.adminSettings = [...p.adminSettings];
    }
    out.push(row);
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
  probes.delete(name);
}
