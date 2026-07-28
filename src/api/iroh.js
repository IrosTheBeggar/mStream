// Non-admin Iroh API.
//
// Exposes the pairing code over the auth-walled (non-admin-network-gated) API so
// a client can configure a roaming Iroh connection after a plain login. The code
// embeds the connect secret, so it is only revealed to:
//   * an authenticated ADMIN — the typical case: the server owner pairing their
//     own device (e.g. LAN discovery → login → fetch code). Unlike the admin API
//     (src/api/admin.js) this route has no admin-network gate, so it works from a
//     phone on the LAN; the secret still only gates the tunnel pipe, not the API.
//   * any authenticated user, when the operator opts in via `iroh.shareCodePublic`
//     (public/demo servers that want anyone to be able to test an Iroh connection).
// Mounted AFTER the auth wall, so on a server with user accounts it still requires
// login; on a public-mode (no-users) demo with shareCodePublic it's effectively
// public, which is the intent.

import * as config from '../state/config.js';

export function setup(mstream) {
  mstream.get('/api/v1/iroh/code', async (req, res) => {
    const enabled = config.program.iroh.enabled === true;
    const shared = enabled
      && (config.program.iroh.shareCodePublic === true || req.user?.admin === true);
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
