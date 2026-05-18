// Admin-side torrent endpoints. Extracted from admin.js to keep that
// file from accreting the full torrent surface (~300 lines and
// counting). Same pattern as the other sub-feature splits — exports
// a `register(mstream)` function called once during admin setup.
//
// Three concern groups, each marked with a section header below:
//
//   1. Client-pick / whitelist policy / per-user toggle
//   2. Per-client connection lifecycle (test / connect / disconnect /
//      status / list) for Transmission + qBittorrent. Helpers
//      `_getClientModule` and `_activeClientCreds` dispatch on the
//      active client so handlers stay client-agnostic.
//   3. Per-vpath path-mapping access cache (auto-detect / manual /
//      read). The cache + the path-probe primitive together form the
//      gate the user-facing add-torrent endpoint consults.
//
// All routes are mounted under /api/v1/admin/*, so they inherit the
// admin guard set up by adminApi.setup in src/api/admin.js — no
// per-route auth check needed here.

import Joi from 'joi';
import * as admin from '../util/admin.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

import * as transmissionRpc from '../torrent/transmission-rpc.js';
import * as qbittorrentRpc  from '../torrent/qbittorrent-rpc.js';
import * as delugeRpc        from '../torrent/deluge-rpc.js';
import * as managedTorrents  from '../torrent/managed-torrents.js';
import * as pathProbe        from '../torrent/path-probe.js';
import * as vpathAccessCache from '../torrent/vpath-access-cache.js';
import { CLIENT_TYPE, ENABLED_FOR, SOURCE, isClientActive } from '../torrent/constants.js';

// Dispatch helper. Both client modules export the same {testConnection,
// listTorrents, addTorrent, getKnownPaths} surface — the admin
// endpoints stay client-agnostic by resolving the implementation here.
function _getClientModule(type) {
  if (type === CLIENT_TYPE.TRANSMISSION) { return transmissionRpc; }
  if (type === CLIENT_TYPE.QBITTORRENT)  { return qbittorrentRpc; }
  if (type === CLIENT_TYPE.DELUGE)       { return delugeRpc; }
  return null;
}

// Pull the saved-credentials block for the active client. Returns
// `null` when no client is selected or when the active client has no
// host saved yet (UI shows the login form).
function _activeClientCreds() {
  const client = config.program.torrent.client;
  if (client === CLIENT_TYPE.TRANSMISSION) {
    const t = config.program.torrent.transmission || {};
    return t.host ? { type: CLIENT_TYPE.TRANSMISSION, creds: t, module: transmissionRpc } : null;
  }
  if (client === CLIENT_TYPE.QBITTORRENT) {
    const q = config.program.torrent.qbittorrent || {};
    return q.host ? { type: CLIENT_TYPE.QBITTORRENT, creds: q, module: qbittorrentRpc } : null;
  }
  if (client === CLIENT_TYPE.DELUGE) {
    const d = config.program.torrent.deluge || {};
    return d.host ? { type: CLIENT_TYPE.DELUGE, creds: d, module: delugeRpc } : null;
  }
  return null;
}

// After a successful Connect (or admin-triggered refresh), sweep
// every configured library against the active client and write probe
// results to the cache. Manual entries are preserved by the UPSERT —
// see vpathAccessCache.upsert.
//
// Sweeps run in parallel per vpath. Each sweep generates its own
// UUID-random sentinel name and constructs its own memo, so they
// don't share filesystem or in-memory state. The cache UPSERT is
// atomic (V39 + the WHERE-on-DO-UPDATE clause), so concurrent writes
// across vpaths can't corrupt each other.
//
// Worst-case cost is bounded by the slowest single vpath's sweep
// (~one daemon round-trip per generator that fires), not the sum
// across libraries.
async function _sweepVpathsForActiveClient(libraries) {
  const active = config.program.torrent.client;
  if (!isClientActive(active)) { return; }
  const creds =
    active === CLIENT_TYPE.TRANSMISSION ? (config.program.torrent.transmission || {}) :
    active === CLIENT_TYPE.QBITTORRENT  ? (config.program.torrent.qbittorrent  || {}) :
    active === CLIENT_TYPE.DELUGE       ? (config.program.torrent.deluge       || {}) : null;
  if (!creds || !creds.host) { return; }

  await Promise.all(libraries.map(async lib => {
    let result;
    try {
      result = await pathProbe.sweepVpath(lib, creds, active);
    } catch (err) {
      result = { verified: false, confidence: 'unconfirmed', method: 'sweep:exception', reason: err.message };
    }
    vpathAccessCache.upsert({
      clientType: active, vpathName: lib.name, result, source: SOURCE.AUTO,
    });
  }));
}

export function register(mstream) {
  // ── 1. Torrent client + whitelist policy ────────────────────────────────
  // Single mStream-wide setting block (selected client + access
  // policy) plus the per-user whitelist toggle the policy consults.

  mstream.get('/api/v1/admin/torrent', (req, res) => {
    // Both clients' saved-credentials blocks are returned in parallel
    // so the UI knows which backends are "configured" even when not
    // active — useful for an admin who's mid-migration and wants to
    // see "yes, Transmission still has credentials saved, I can flip
    // back without re-typing the password." Passwords are NEVER
    // returned by any GET; only `configured: boolean` plus the
    // non-secret fields.
    const t = config.program.torrent.transmission || {};
    const q = config.program.torrent.qbittorrent  || {};
    const d = config.program.torrent.deluge       || {};
    res.json({
      client:     config.program.torrent.client,
      enabledFor: config.program.torrent.enabledFor,
      transmission: {
        host:       t.host || '',
        port:       t.port || 9091,
        username:   t.username || '',
        rpcPath:    t.rpcPath || '/transmission/rpc',
        useHttps:   !!t.useHttps,
        configured: !!(t.host && t.host.length > 0),
      },
      qbittorrent: {
        host:       q.host || '',
        port:       q.port || 8080,
        username:   q.username || '',
        useHttps:   !!q.useHttps,
        configured: !!(q.host && q.host.length > 0),
      },
      deluge: {
        host:       d.host || '',
        port:       d.port || 8112,
        useHttps:   !!d.useHttps,
        configured: !!(d.host && d.host.length > 0),
      },
    });
  });

  mstream.post('/api/v1/admin/torrent/client', async (req, res) => {
    const schema = Joi.object({
      // Pulled from the CLIENT_TYPE enum so adding a new backend
      // (Deluge, rTorrent, …) extends this validator automatically.
      client: Joi.string().valid(...Object.values(CLIENT_TYPE)).required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    await admin.editTorrentClient(value.client);
    res.json({});
  });

  mstream.post('/api/v1/admin/torrent/enabled-for', async (req, res) => {
    const schema = Joi.object({
      // Pulled from ENABLED_FOR so a future ALLOW_FOR option (or
      // similar) extends the validator automatically.
      enabledFor: Joi.string().valid(...Object.values(ENABLED_FOR)).required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    await admin.editTorrentEnabledFor(value.enabledFor);
    res.json({});
  });

  // V36: per-user whitelist toggle. Separate from /users/access (which
  // bundles the older admin/mkdir/upload/etc flags) so the torrent
  // settings page can drive it without round-tripping unrelated state.
  mstream.post('/api/v1/admin/users/torrent-access', async (req, res) => {
    const schema = Joi.object({
      username:     Joi.string().required(),
      allowTorrent: Joi.boolean().required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    await admin.editUserAllowTorrent(value.username, value.allowTorrent);
    res.json({});
  });

  // ── 2. Per-client connection lifecycle ──────────────────────────────────
  // The four endpoints below are intentionally split:
  //   /test       — try creds from the request body, NEVER touch config
  //   /connect    — same probe; on success, persist creds + return ok
  //   /disconnect — clear saved creds, no probe
  //   /status     — probe the SAVED creds; the UI polls this for the
  //                 connection badge.
  // Splitting /test and /connect lets a "Test" button on the login
  // form give the admin feedback before they commit the password to
  // disk.

  const _transmissionCredsBody = Joi.object({
    host:     Joi.string().min(1).required(),
    port:     Joi.number().integer().min(1).max(65535).default(9091),
    username: Joi.string().allow('').default(''),
    // Allow empty password so "no auth" Transmission setups work.
    password: Joi.string().allow('').default(''),
    rpcPath:  Joi.string().default('/transmission/rpc'),
    useHttps: Joi.boolean().default(false),
  });

  mstream.post('/api/v1/admin/torrent/transmission/test', async (req, res) => {
    const { value } = joiValidate(_transmissionCredsBody, req.body || {});
    try {
      const info = await transmissionRpc.testConnection(value);
      res.json({ ok: true, version: info.version, rpcVersion: info.rpcVersion });
    } catch (err) {
      // Never 500 here — a failed connection is a normal UI state, not
      // an API error. The UI renders `error` directly to the admin.
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/transmission/connect', async (req, res) => {
    const { value } = joiValidate(_transmissionCredsBody, req.body || {});
    try {
      const info = await transmissionRpc.testConnection(value);
      await admin.editTorrentTransmission(value);
      // Path-probe sweep is fire-and-forget for response latency but
      // still awaited so the client sees fresh state when it next
      // calls /vpath-access. Failures are individually captured by
      // _sweepVpathsForActiveClient — we don't fail the connect.
      if (config.program.torrent.client === CLIENT_TYPE.TRANSMISSION) {
        await _sweepVpathsForActiveClient(db.getAllLibraries());
      }
      res.json({ ok: true, version: info.version, rpcVersion: info.rpcVersion });
    } catch (err) {
      // Probe failed → do NOT persist. Mirrors the /test response.
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/transmission/disconnect', async (req, res) => {
    await admin.editTorrentTransmission(null);
    res.json({});
  });

  // qBittorrent counterparts. Same shape, same response contract.
  // qBittorrent has no `rpcPath` field — the WebAPI mount point is
  // fixed at /api/v2/* — so the body schema is a strict subset of
  // Transmission's.
  const _qbittorrentCredsBody = Joi.object({
    host:     Joi.string().min(1).required(),
    port:     Joi.number().integer().min(1).max(65535).default(8080),
    username: Joi.string().allow('').default(''),
    password: Joi.string().allow('').default(''),
    useHttps: Joi.boolean().default(false),
  });

  mstream.post('/api/v1/admin/torrent/qbittorrent/test', async (req, res) => {
    const { value } = joiValidate(_qbittorrentCredsBody, req.body || {});
    try {
      const info = await qbittorrentRpc.testConnection(value);
      res.json({ ok: true, version: info.version });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/qbittorrent/connect', async (req, res) => {
    const { value } = joiValidate(_qbittorrentCredsBody, req.body || {});
    try {
      const info = await qbittorrentRpc.testConnection(value);
      await admin.editTorrentQbittorrent(value);
      if (config.program.torrent.client === CLIENT_TYPE.QBITTORRENT) {
        await _sweepVpathsForActiveClient(db.getAllLibraries());
      }
      res.json({ ok: true, version: info.version });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/qbittorrent/disconnect', async (req, res) => {
    await admin.editTorrentQbittorrent(null);
    res.json({});
  });

  // Deluge counterparts. Deluge WebUI auth is password-only — no
  // username field — so the body schema is even smaller than
  // qBittorrent's.
  const _delugeCredsBody = Joi.object({
    host:     Joi.string().min(1).required(),
    port:     Joi.number().integer().min(1).max(65535).default(8112),
    password: Joi.string().allow('').default(''),
    useHttps: Joi.boolean().default(false),
  });

  mstream.post('/api/v1/admin/torrent/deluge/test', async (req, res) => {
    const { value } = joiValidate(_delugeCredsBody, req.body || {});
    try {
      const info = await delugeRpc.testConnection(value);
      res.json({ ok: true, version: info.version });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/deluge/connect', async (req, res) => {
    const { value } = joiValidate(_delugeCredsBody, req.body || {});
    try {
      const info = await delugeRpc.testConnection(value);
      await admin.editTorrentDeluge(value);
      if (config.program.torrent.client === CLIENT_TYPE.DELUGE) {
        await _sweepVpathsForActiveClient(db.getAllLibraries());
      }
      res.json({ ok: true, version: info.version });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  mstream.post('/api/v1/admin/torrent/deluge/disconnect', async (req, res) => {
    await admin.editTorrentDeluge(null);
    res.json({});
  });

  // List every torrent the configured client currently knows about.
  // Joins each row against `managed_torrents` so the UI can flag
  // entries added through mStream vs added directly through the
  // daemon's own clients. Returns `{ torrents: [...], error: null }`
  // on success, or `{ torrents: [], error: "..." }` on every soft
  // failure mode (client disabled, no creds, daemon unreachable).
  // We never 500 — the empty list IS the UI state.
  mstream.get('/api/v1/admin/torrent/list', async (req, res) => {
    const active = _activeClientCreds();
    if (!active) {
      const client = config.program.torrent.client;
      const reason = isClientActive(client) ? 'No credentials saved' : 'No torrent client selected';
      return res.json({ torrents: [], error: reason, clientType: client });
    }
    let torrents;
    try {
      torrents = await active.module.listTorrents(active.creds);
    } catch (err) {
      return res.json({ torrents: [], error: err.message, clientType: active.type });
    }
    // The managed-row join is scoped to the active client so a hash
    // that's only registered against the *other* client doesn't
    // accidentally light up the "managed by mStream" badge here.
    const owned = managedTorrents.getByHashes(
      torrents.map(x => x.infoHash),
      active.type,
    );
    for (const t of torrents) {
      const m = owned.get(t.infoHash);
      t.managedByMstream = !!m;
      t.managedBy        = m?.username || null;
    }
    res.json({ torrents, error: null, clientType: active.type });
  });

  mstream.get('/api/v1/admin/torrent/status', async (req, res) => {
    const client = config.program.torrent.client;
    if (!isClientActive(client)) {
      return res.json({ connected: false, configured: false, clientType: client, reason: 'No torrent client selected' });
    }
    const active = _activeClientCreds();
    if (!active) {
      return res.json({ connected: false, configured: false, clientType: client, reason: 'No credentials saved' });
    }
    try {
      const info = await active.module.testConnection(active.creds);
      res.json({
        connected:  true,
        configured: true,
        clientType: active.type,
        version:    info.version,
        rpcVersion: info.rpcVersion,
      });
    } catch (err) {
      res.json({ connected: false, configured: true, clientType: active.type, reason: err.message });
    }
  });

  // ── 3. Per-vpath path-mapping access cache ──────────────────────────────
  //
  // The admin UI shows one row per library with the verified daemon-side
  // absolute path (when confirmed) or an input field (when not).
  // /vpath-access returns the cached truth; /auto-detect re-runs the
  // generator pipeline; /manual lets the operator type a daemon path
  // and verify it via the same probe primitive.
  //
  // All three operate on the ACTIVE client. Inactive clients keep
  // their cached rows but they're invisible until they become active
  // again — switching the active client doesn't trigger a re-probe by
  // itself, but Connect against the newly-active client does.

  mstream.get('/api/v1/admin/torrent/vpath-access', (req, res) => {
    const active = config.program.torrent.client;
    if (!isClientActive(active)) {
      return res.json({ clientType: active, vpaths: {}, error: 'No torrent client selected' });
    }
    res.json({ clientType: active, vpaths: vpathAccessCache.getAllForClient(active) });
  });

  mstream.post('/api/v1/admin/torrent/vpath-access/auto-detect', async (req, res) => {
    const schema = Joi.object({
      vpathName: Joi.string().optional(),  // omit to sweep all
    });
    const { value } = joiValidate(schema, req.body || {});
    const active = config.program.torrent.client;
    if (!isClientActive(active)) { return res.status(409).json({ error: 'No torrent client selected' }); }

    let libs = db.getAllLibraries();
    if (value.vpathName) {
      libs = libs.filter(l => l.name === value.vpathName);
      if (libs.length === 0) { return res.status(404).json({ error: `Unknown vpath '${value.vpathName}'` }); }
    }
    await _sweepVpathsForActiveClient(libs);
    res.json({ clientType: active, vpaths: vpathAccessCache.getAllForClient(active) });
  });

  mstream.post('/api/v1/admin/torrent/vpath-access/manual', async (req, res) => {
    const schema = Joi.object({
      vpathName:  Joi.string().required(),
      daemonPath: Joi.string().min(1).required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    const active = config.program.torrent.client;
    if (!isClientActive(active)) { return res.status(409).json({ error: 'No torrent client selected' }); }

    const lib = db.getLibraryByName(value.vpathName);
    if (!lib) { return res.status(404).json({ error: `Unknown vpath '${value.vpathName}'` }); }

    const creds =
      active === CLIENT_TYPE.TRANSMISSION ? (config.program.torrent.transmission || {}) :
      active === CLIENT_TYPE.QBITTORRENT  ? (config.program.torrent.qbittorrent  || {}) :
                                            (config.program.torrent.deluge       || {});
    if (!creds.host) { return res.status(412).json({ error: `No saved credentials for ${active}` }); }

    // Single-candidate orchestrator call — same primitive as auto-detect.
    const result = await pathProbe.autoDetectMapping(lib, creds, active, [{
      daemonPath:        value.daemonPath,
      mstreamMirrorPath: lib.root_path,
      source:            SOURCE.MANUAL,
    }]);
    vpathAccessCache.upsert({
      clientType: active,
      vpathName:  value.vpathName,
      result,
      source:     SOURCE.MANUAL,  // sticks even if verification failed
                                  // — operator can still see what they
                                  // tried in the cache row
    });
    if (result.verified) {
      return res.json({ ok: true, clientType: active, ...result });
    }
    return res.status(422).json({
      ok: false, clientType: active,
      error: 'verification_failed',
      message: result.attempts?.[0]?.reason || 'daemon could not verify the supplied path',
      ...result,
    });
  });
}
