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
    res.json({ enabled, available, running: endpointId !== null, endpointId, online: relayUrl !== null, relayUrl });
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
    }
    res.json(keys);
  });

  mstream.post('/api/v1/admin/federation/keys', async (req, res) => {
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
    const ticket = await ticketForKey({ ...minted, library_names: req.body.vpaths });
    res.json({ id: minted.id, name: minted.name, key: minted.key, ticket });
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
    winston.info(`[federation] ${req.user.username} removed peer id=${id}`);
    res.json({});
  });
}
