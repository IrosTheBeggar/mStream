// Non-admin Iroh API.
//
// Exposes the pairing code to ordinary users (the web player) — but ONLY when
// the operator opts in via `iroh.shareCodePublic`. The code embeds the connect
// secret, so by default it stays admin-only (src/api/admin.js). This endpoint
// exists for public/demo servers that want anyone to be able to test an Iroh
// connection. It is mounted AFTER the auth wall, so on a server with user
// accounts it still requires login; on a public-mode (no-users) demo it's
// effectively public, which is the intent.

import * as config from '../state/config.js';

export function setup(mstream) {
  mstream.get('/api/v1/iroh/code', async (req, res) => {
    const enabled = config.program.iroh.enabled === true;
    const shared = enabled && config.program.iroh.shareCodePublic === true;
    if (!shared) {
      // Don't reveal the code; tell the client the feature isn't being shared.
      return res.json({ enabled, shared: false });
    }
    try {
      const iroh = await import('../state/iroh.js');
      const code = iroh.getTicket();
      if (!code) {
        return res.json({ enabled, shared: true, available: false });
      }
      const addr = iroh.getEndpointAddr();
      return res.json({
        enabled,
        shared: true,
        available: true,
        endpointId: iroh.getEndpointId(),
        online: addr ? addr.relayUrl() !== null : false,
        code,
      });
    } catch (_err) {
      // Native module unavailable on this platform.
      return res.json({ enabled, shared: true, available: false });
    }
  });
}
