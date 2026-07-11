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

import os from 'os';
import winston from 'winston';
import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';
import * as sim from '../db/discovery-similarity.js';

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
    });
  });
}
