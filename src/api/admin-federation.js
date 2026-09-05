// Admin-side federation endpoints. Extracted from admin.js to keep that file
// from accreting the federation surface — same pattern as admin-torrent.js:
// exports a `register(mstream)` function called once during admin setup, so
// every route here inherits the /api/v1/admin/* guard (admin role + network
// gate) registered before it.
//
// This module owns:
//   - the endpoint lifecycle: status + live enable/disable (the endpoint is
//     independent of the HTTP server, so no reboot — mirror of the iroh
//     tunnel admin routes);
//   - the credential side: minting read-only keys scoped to selected
//     libraries, listing them (with their swap-ready mstrfed1: tickets when
//     the endpoint is up), revoking (which also severs live pipes), and
//     resetting a key's TOFU endpoint binding (the "friend reinstalled and
//     has a new iroh identity" escape hatch).

import os from 'os';
import Joi from 'joi';
import winston from 'winston';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import * as config from '../state/config.js';
import * as admin from '../util/admin.js';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as fedLimits from './federation-limits.js';
import { forgetPeerAccess } from './federation-browse.js';

// Per-key bandwidth caps (0 = unlimited). Optional at mint time — absent
// fields fall back to config.federation.limits, which is also what the UI
// pre-fills, so "just hit Mint" applies the configured defaults.
const limitsSchema = {
  streamKbps: Joi.number().integer().min(0).max(10000000),
  dailyMb: Joi.number().integer().min(0).max(100000000),
  maxStreams: Joi.number().integer().min(0).max(1000),
};

function resolveLimits(body) {
  const defaults = config.program.federation.limits;
  return {
    streamKbps: body.streamKbps ?? defaults.streamKbps,
    dailyMb: body.dailyMb ?? defaults.dailyMb,
    maxStreams: body.maxStreams ?? defaults.maxStreams,
  };
}

// Key expiry (V62): ISO datetime, must be in the future (renewing an
// expired key means picking a new future date), null = never. joiValidate
// doesn't write Joi's converted value back into req.body, so routes
// normalize the accepted string themselves.
const expirySchema = Joi.date().iso().greater('now').allow(null);

function normalizeExpiry(bodyValue) {
  return bodyValue ? new Date(bodyValue).toISOString() : null;
}

// Rows store SQLite's canonical UTC 'YYYY-MM-DD HH:MM:SS'; tickets and API
// consumers get real ISO.
function sqliteUtcToIso(s) {
  return s ? `${s.replace(' ', 'T')}Z` : null;
}

// Build the swap-ready ticket for a minted key, or null when the endpoint
// isn't running (native module missing / feature off).
async function ticketForKey(keyRow) {
  try {
    const federation = await import('../state/federation.js');
    const endpointTicket = federation.getEndpointTicket();
    if (!endpointTicket) { return null; }
    return federation.buildFederationTicket({
      endpointTicket,
      key: keyRow.key,
      serverName: config.program.federation.serverName || os.hostname(),
      libraries: keyRow.library_names,
      expiresAt: sqliteUtcToIso(keyRow.expires_at),
    });
  } catch (_err) {
    return null; // native binary not present on this platform
  }
}

export function register(mstream) {
  mstream.get('/api/v1/admin/federation', async (req, res) => {
    const enabled = config.program.federation.enabled === true;
    let available = true;
    let endpointId = null;
    let relayUrl = null;
    try {
      const federation = await import('../state/federation.js');
      endpointId = federation.getEndpointId();
      if (endpointId) {
        const addr = federation.getEndpointAddr();
        relayUrl = addr ? addr.relayUrl() : null;
      }
    } catch (_err) {
      available = false; // native binary not present on this platform
    }
    res.json({
      enabled, available, running: endpointId !== null, endpointId,
      online: relayUrl !== null, relayUrl,
      // What the mint dialog pre-fills; per-key values live on the key rows.
      limitDefaults: config.program.federation.limits,
      // The federation-requests inbox (V67): whether discovery peers may
      // send this server pairing requests.
      acceptRequests: config.program.federation.acceptRequests === true,
    });
  });

  mstream.post('/api/v1/admin/federation', async (req, res) => {
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);
    const enabled = req.body.enabled;

    const raw = await admin.loadFile(config.configFile);
    if (!raw.federation) { raw.federation = {}; }
    raw.federation.enabled = enabled;
    await admin.saveFile(raw, config.configFile);
    config.program.federation.enabled = enabled;

    try {
      const federation = await import('../state/federation.js');
      if (enabled) {
        await federation.start({
          targetPort: config.program.port,
          secretKey: config.program.federation.secretKey,
        });
      } else {
        // Peer bridges dial from this endpoint; drop them with it.
        const client = await import('../state/federation-client.js');
        client.stopAll();
        await federation.stop();
      }
      res.json({ enabled, available: true });
    } catch (err) {
      winston.error('[federation] admin toggle failed — endpoint unavailable on this platform', { stack: err });
      res.json({ enabled, available: false });
    }
  });

  mstream.get('/api/v1/admin/federation/keys', async (req, res) => {
    const keys = fedDb.getFederationKeys();
    for (const k of keys) {
      k.ticket = await ticketForKey(k);
      // Live figure: DB baseline plus the accumulator's unflushed remainder,
      // so the UI never lags the flush interval.
      k.usage_today_bytes = fedLimits.usedTodayBytes(k.id);
    }
    res.json(keys);
  });

  mstream.post('/api/v1/admin/federation/keys', async (req, res) => {
    const schema = Joi.object({
      name: Joi.string().min(1).max(64).required(),
      vpaths: Joi.array().items(Joi.string()).min(1).unique().required(),
      ...limitsSchema,
      expiresAt: expirySchema,
    });
    joiValidate(schema, req.body);

    // Resolve vpath names -> library ids up front so one unknown name fails
    // the whole mint (grants are transactional in createFederationKey too).
    const libraryIds = req.body.vpaths.map((name) => {
      const lib = db.getLibraryByName(name);
      if (!lib) { throw new WebError(`Unknown library: ${name}`, 404); }
      return lib.id;
    });

    const limits = resolveLimits(req.body);
    const expiresAt = normalizeExpiry(req.body.expiresAt);
    const minted = fedDb.createFederationKey(req.body.name, libraryIds, limits, expiresAt);
    // A fresh key means a fresh dial is coming — typically from the same
    // friend whose retries on a key just revoked are what the endpoint
    // backed off (mStream #940: a peer re-added right after a revocation
    // was refused for a minute). Forgive every backed-off remote now.
    try {
      const federation = await import('../state/federation.js');
      federation.clearHandshakeBackoff();
    } catch (_err) { /* native binary not present — no endpoint, nothing backed off */ }
    winston.info(`[federation] ${req.user.username} minted key '${minted.name}' for libraries [${req.body.vpaths.join(', ')}] `
      + `(limits: ${limits.streamKbps} kbps, ${limits.dailyMb} MB/day, ${limits.maxStreams} streams; `
      + `expires: ${expiresAt || 'never'})`);
    // Re-read for the stored (normalized) expiry so the ticket's `e` field
    // matches the row exactly.
    const fresh = fedDb.getFederationKeyById(minted.id);
    const ticket = await ticketForKey({ ...fresh, library_names: req.body.vpaths });
    res.json({
      id: minted.id, name: minted.name, key: minted.key, ticket, ...limits,
      expiresAt: sqliteUtcToIso(fresh.expires_at),
    });
  });

  // Live per-key limit edit — applies from the next request on. A stream
  // that is already open keeps the rate it started with (the wrapper
  // captured it); revoking the key remains the hard stop. `expiresAt` is
  // tri-state: absent = unchanged, null = never, ISO = new future cutoff
  // (which is also how an expired key gets renewed).
  mstream.post('/api/v1/admin/federation/keys/:id/limits', (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    joiValidate(Joi.object({
      streamKbps: limitsSchema.streamKbps.required(),
      dailyMb: limitsSchema.dailyMb.required(),
      maxStreams: limitsSchema.maxStreams.required(),
      expiresAt: expirySchema,
    }), req.body);

    const id = Number(req.params.id);
    if (!fedDb.setFederationKeyLimits(id, req.body)) {
      throw new WebError('Key not found', 404);
    }
    let expiryNote = '';
    if ('expiresAt' in req.body) {
      const expiresAt = normalizeExpiry(req.body.expiresAt);
      fedDb.setFederationKeyExpiry(id, expiresAt);
      expiryNote = `; expires: ${expiresAt || 'never'}`;
    }
    winston.info(`[federation] ${req.user.username} set limits on key id=${id}: `
      + `${req.body.streamKbps} kbps, ${req.body.dailyMb} MB/day, ${req.body.maxStreams} streams${expiryNote}`);
    res.json(fedDb.getFederationKeyById(id));
  });

  mstream.delete('/api/v1/admin/federation/keys/:id', async (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.params);

    if (!fedDb.deleteFederationKey(Number(req.params.id))) {
      throw new WebError('Key not found', 404);
    }
    // Sever any live pipes riding this key — new handshakes and HTTP
    // requests already fail on the deleted row.
    try {
      const federation = await import('../state/federation.js');
      const closed = federation.closeConnectionsForKey(Number(req.params.id));
      if (closed > 0) { winston.info(`[federation] closed ${closed} live connection(s) for revoked key id=${req.params.id}`); }
    } catch (_err) { /* native binary not present — nothing live to close */ }
    // Its unflushed usage would fail its FOREIGN KEY forever (mStream #940).
    fedLimits.forgetKey(Number(req.params.id));
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

  // ── Federation requests (in-network pairing over discovery DMs) ─────
  //
  // The engine (state/federation-requests.js) throws plain Errors; these
  // routes map them: unknown rows 404, state/feature conflicts 409,
  // everything else 400. Dynamic imports keep the p2p modules unloaded
  // until the feature is actually touched, same as the federation imports
  // above.

  function requestError(err) {
    if (/not found/i.test(err.message)) { return new WebError(err.message, 404); }
    if (/not enabled|not running|already|cannot (accept|reject|cancel)/i.test(err.message)) {
      return new WebError(err.message, 409);
    }
    return new WebError(err.message, 400);
  }

  mstream.get('/api/v1/admin/federation/requests', async (req, res) => {
    const reqDb = await import('../db/federation-requests.js');
    res.json({
      acceptRequests: config.program.federation.acceptRequests === true,
      requests: reqDb.listRequests(),
    });
  });

  mstream.post('/api/v1/admin/federation/requests', async (req, res) => {
    const schema = Joi.object({
      endpointId: Joi.string().min(16).max(128).required(),
      message: Joi.string().max(500).allow('').optional(),
      offerVpaths: Joi.array().items(Joi.string()).max(32).unique().default([]),
    });
    joiValidate(schema, req.body);
    // Offered names must exist NOW so a typo fails the compose, not the
    // grant-back two DMs later (deleted-meanwhile is still handled there).
    for (const name of req.body.offerVpaths || []) {
      if (!db.getLibraryByName(name)) { throw new WebError(`Unknown library: ${name}`, 404); }
    }
    const engine = await import('../state/federation-requests.js');
    try {
      const row = await engine.compose({
        peerEndpointId: req.body.endpointId,
        message: req.body.message || null,
        offeredLibraries: req.body.offerVpaths || [],
      });
      winston.info(`[federation] ${req.user.username} sent a federation request to ${req.body.endpointId.slice(0, 12)}…`);
      res.json(row);
    } catch (err) {
      winston.warn(`[federation] ${req.user.username} compose failed: ${err.message}`);
      throw requestError(err);
    }
  });

  mstream.post('/api/v1/admin/federation/requests/:id/accept', async (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    joiValidate(Joi.object({
      vpaths: Joi.array().items(Joi.string()).min(1).unique().required(),
      ...limitsSchema,
      expiresAt: expirySchema,
      acceptTheirOffer: Joi.boolean().default(true),
    }), req.body);

    const libraryIds = req.body.vpaths.map((name) => {
      const lib = db.getLibraryByName(name);
      if (!lib) { throw new WebError(`Unknown library: ${name}`, 404); }
      return lib.id;
    });
    const engine = await import('../state/federation-requests.js');
    try {
      const row = await engine.accept(Number(req.params.id), {
        libraryIds,
        vpathNames: req.body.vpaths,
        limits: resolveLimits(req.body),
        expiresAt: normalizeExpiry(req.body.expiresAt),
        acceptTheirOffer: req.body.acceptTheirOffer !== false,
      });
      winston.info(`[federation] ${req.user.username} accepted federation request id=${req.params.id}`);
      res.json(row);
    } catch (err) {
      winston.warn(`[federation] ${req.user.username} accept failed for request id=${req.params.id}: ${err.message}`);
      throw requestError(err);
    }
  });

  mstream.post('/api/v1/admin/federation/requests/:id/reject', async (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    joiValidate(Joi.object({ reason: Joi.string().max(200).allow('').optional() }), req.body);
    const engine = await import('../state/federation-requests.js');
    try {
      const row = await engine.reject(Number(req.params.id), req.body.reason || null);
      winston.info(`[federation] ${req.user.username} rejected federation request id=${req.params.id}`);
      res.json(row);
    } catch (err) {
      throw requestError(err);
    }
  });

  mstream.post('/api/v1/admin/federation/requests/:id/cancel', async (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    const engine = await import('../state/federation-requests.js');
    try {
      const row = await engine.cancel(Number(req.params.id));
      winston.info(`[federation] ${req.user.username} cancelled federation request id=${req.params.id}`);
      res.json(row);
    } catch (err) {
      throw requestError(err);
    }
  });

  // Dismiss a finished record. Live exchanges must be cancelled/rejected
  // first — deleting one mid-flight would orphan its retry state.
  mstream.delete('/api/v1/admin/federation/requests/:id', async (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    const reqDb = await import('../db/federation-requests.js');
    const row = reqDb.getRequestById(Number(req.params.id));
    if (!row) { throw new WebError('Request not found', 404); }
    if (reqDb.ACTIVE_STATES.includes(row.state)) {
      throw new WebError(`cannot dismiss a request in state '${row.state}' — cancel or reject it first`, 409);
    }
    reqDb.deleteRequest(row.id);
    winston.info(`[federation] ${req.user.username} dismissed federation request id=${row.id} (${row.state})`);
    res.json({});
  });

  // The inbox switch, live: persists federation.acceptRequests and pushes
  // the DM-accept policy down to the sidecar in the same breath.
  mstream.post('/api/v1/admin/federation/accept-requests', async (req, res) => {
    joiValidate(Joi.object({ enabled: Joi.boolean().required() }), req.body);
    const enabled = req.body.enabled;

    const raw = await admin.loadFile(config.configFile);
    if (!raw.federation) { raw.federation = {}; }
    raw.federation.acceptRequests = enabled;
    await admin.saveFile(raw, config.configFile);
    config.program.federation.acceptRequests = enabled;

    const engine = await import('../state/federation-requests.js');
    await engine.pushAcceptPolicy();
    winston.info(`[federation] ${req.user.username} turned the federation-requests inbox ${enabled ? 'on' : 'off'}`);
    res.json({ acceptRequests: enabled });
  });

  // ── Peers (servers this one can read) ──────────────────────────────

  mstream.get('/api/v1/admin/federation/peers', (req, res) => {
    res.json(fedDb.getFederationPeers());
  });

  mstream.post('/api/v1/admin/federation/peers', async (req, res) => {
    const schema = Joi.object({
      ticket: Joi.string().min(1).required(),
      name: Joi.string().min(1).max(64).optional(),
    });
    joiValidate(schema, req.body);

    let parsed;
    try {
      const federation = await import('../state/federation.js');
      parsed = federation.parseFederationTicket(req.body.ticket);
    } catch (err) {
      winston.warn(`[federation] ${req.user.username} pasted an unparseable ticket: ${err.message}`);
      throw new WebError(err.message, 400);
    }

    let peer;
    try {
      peer = fedDb.addFederationPeer({
        name: req.body.name || parsed.name || 'Unnamed server',
        endpointTicket: parsed.endpointTicket,
        apiKey: parsed.apiKey,
      });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) { throw new WebError('This ticket is already added as a peer', 400); }
      throw err;
    }
    winston.info(`[federation] ${req.user.username} added peer '${peer.name}' (id=${peer.id})`);

    // Fire-and-forget first health check so the UI's status dot fills in
    // without an extra click; the response returns immediately.
    (async () => {
      try {
        const client = await import('../state/federation-client.js');
        await client.testPeer(peer);
      } catch (err) {
        winston.warn(`[federation] initial test-connect for peer '${peer.name}' failed: ${err.message}`);
      }
    })();

    res.json({ ...peer, ticketLibraries: parsed.libraries });
  });

  mstream.post('/api/v1/admin/federation/peers/:id/test', async (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.params);

    const peer = fedDb.getFederationPeerById(Number(req.params.id));
    if (!peer) { throw new WebError('Peer not found', 404); }

    const client = await import('../state/federation-client.js');
    const result = await client.testPeer(peer);
    res.json({ ...result, peer: fedDb.getFederationPeerById(peer.id) });
  });

  // Per-peer opt-out for OUTBOUND discovery queries (sending this peer our
  // seed vectors from the Discover panel). The inbound direction has no
  // flag — see the SCHEMA_V58 comment.
  mstream.post('/api/v1/admin/federation/peers/:id/discovery', (req, res) => {
    joiValidate(Joi.object({ id: Joi.number().integer().min(1).required() }), req.params);
    joiValidate(Joi.object({ enabled: Joi.boolean().required() }), req.body);

    const id = Number(req.params.id);
    if (!fedDb.setFederationPeerUseDiscovery(id, req.body.enabled)) {
      throw new WebError('Peer not found', 404);
    }
    winston.info(`[federation] ${req.user.username} turned discovery ${req.body.enabled ? 'on' : 'off'} for peer id=${id}`);
    res.json(fedDb.getFederationPeerById(id));
  });

  mstream.delete('/api/v1/admin/federation/peers/:id', async (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.params);

    const id = Number(req.params.id);
    if (!fedDb.deleteFederationPeer(id)) {
      throw new WebError('Peer not found', 404);
    }
    try {
      const client = await import('../state/federation-client.js');
      client.closePeerBridge(id);
    } catch (_err) { /* nothing live to close */ }
    forgetPeerAccess(id);
    winston.info(`[federation] ${req.user.username} removed peer id=${id}`);
    res.json({});
  });
}
