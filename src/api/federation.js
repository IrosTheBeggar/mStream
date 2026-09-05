// Peer-facing federation API (mounted behind the auth wall).
//
// The health/identity probe a federated peer hits to test the pairing and
// learn what it was granted. The peer authenticates with its
// x-federation-key header (see api/federation-auth.js), so req.user.vpaths
// IS the key's live grant list — a grant change on this server shows up on
// the peer's next health check without re-pairing. It also advertises the
// discovery capability block, so a peer knows whether (and in which model
// space) it can send vector queries (api/federation-discovery.js).
//
// Regular logged-in users can also hit this route; they just see their own
// vpaths, which they already know. Harmless.
//
// Also the guest mint: a paired server asks, over its bound pipe, for a
// short-lived token one of its OWN devices (the mobile app) can dial us
// with directly, so the device's bytes stop crossing the holder's home link
// twice (state/federation-guest.js). Same wall, same key: the caller is the
// key holder, and the token it gets back is scoped exactly like the key.

import os from 'os';
import winston from 'winston';
import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as fedDb from '../db/federation.js';
import * as sim from '../db/discovery-similarity.js';
import { mintGuestToken } from '../state/federation-guest.js';
import WebError from '../util/web-error.js';

// What a peer needs before sending vector queries: can this server answer
// at all, and in which model space. null = don't bother querying. The index
// is rowversion-cached, so this is only expensive on the first call after a
// dataset change — the same build the first similarity query would pay.
function discoveryCapability() {
  if (config.program.scanOptions.collectDiscoveryData !== true) { return null; }
  let index;
  try {
    index = sim.getIndex();
  } catch (err) {
    winston.warn(`[federation] discovery capability unavailable: ${err.message}`);
    return null;
  }
  if (!index || index.dim === null) { return null; }   // no store, or zero vectors
  return {
    modelId: index.modelId,
    modelVersion: index.modelVersion,
    dim: index.dim,
    analyzedCount: index.entries.length,
  };
}

export function setup(mstream) {
  mstream.get('/api/v1/federation/health', (req, res) => {
    res.json({
      server: packageJson.version,
      name: config.program.federation.serverName || os.hostname(),
      libraries: req.user.vpaths,
      discovery: discoveryCapability(),
      // This build mints guest tokens (POST /api/v1/federation/guest), so a
      // parent may offer its devices a direct path to us. A flag, not a
      // probe — like everything else a peer learns here.
      guestAccess: true,
    });
  });

  // Mint a GUEST token for the caller's key. Callable only with a federation
  // key that has completed the pipe handshake (bound) — in practice: by the
  // parent, over the bridge. A guest may not mint guests, and a local user
  // has no key to mint for. The token is what the parent's access route
  // (api/federation-browse.js) hands its device; see federation-guest.js
  // for what it resolves to here.
  mstream.post('/api/v1/federation/guest', (req, res) => {
    const user = req.user;
    if (user?.federation !== true) {
      throw new WebError('Guest tokens are minted for federation keys only', 403);
    }
    if (user.federationGuest === true) {
      throw new WebError('A guest cannot mint guests', 403);
    }
    const row = fedDb.getFederationKeyById(user.federationKeyId);
    if (!row || row.expired) { throw new WebError('Authentication Error', 401); }
    if (row.bound_endpoint_id === null) {
      // Never redeemed over the federation endpoint: a key used only over
      // plain HTTP has not shown it can dial, and guests exist to dial.
      throw new WebError('Key is not bound to an endpoint yet — complete the federation handshake first', 403);
    }
    const minted = mintGuestToken(row);
    winston.info(`[federation] minted a guest token for key '${row.name}' (expires ${minted.expiresAt})`);
    res.json(minted);
  });
}
