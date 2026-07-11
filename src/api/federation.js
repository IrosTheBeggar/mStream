// Peer-facing federation API (mounted behind the auth wall).
//
// One endpoint for now: the health/identity probe a federated peer hits to
// test the pairing and learn what it was granted. The peer authenticates
// with its x-federation-key header (see api/federation-auth.js), so
// req.user.vpaths IS the key's live grant list — a grant change on this
// server shows up on the peer's next health check without re-pairing.
//
// Regular logged-in users can also hit this route; they just see their own
// vpaths, which they already know. Harmless.

import os from 'os';
import packageJson from '../../package.json' with { type: 'json' };
import * as config from '../state/config.js';

export function setup(mstream) {
  mstream.get('/api/v1/federation/health', (req, res) => {
    res.json({
      server: packageJson.version,
      name: config.program.federation.serverName || os.hostname(),
      libraries: req.user.vpaths,
    });
  });
}
