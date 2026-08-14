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
// login. On a public-mode (no-users) server the wall grants everyone the admin
// sentinel, so one more gate applies to the DESKTOP bundle — see mayShareCode.

import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { isBunStandalone } from '../util/esm-helpers.js';

// Decide whether this request may receive the pairing code. Pure and exported
// for test/unit/iroh-code-gate.test.mjs.
//
// The standalone clause closes the adversarial review's fresh-install hole:
// the desktop bundle's FIRST-RUN config turns Quick Connect on
// (desktopDefaultConfig: iroh.enabled + shareCodePublic), the server binds
// every interface by default, and with zero accounts the auth wall hands every
// request the admin sentinel — so any device on the LAN could fetch the code,
// whose embedded connectSecret grants a persistent tunnel into the library
// from anywhere. Until the owner creates a real account, a standalone
// (desktop-bundle) server only reveals the code to LOOPBACK callers — the
// owner's own browser, opened from the tray. Server/Docker/source installs
// are exempt: iroh is never auto-enabled there (an operator turned it on
// deliberately — the public-demo use case in the header), and their
// deployment shapes (proxies, containers) make socket addresses unreliable.
//
// remoteAddress must be the SOCKET address (req.socket.remoteAddress), never
// a proxy header — X-Forwarded-For is attacker-controlled, and the desktop
// bundle runs proxyless.
export function mayShareCode({ enabled, shareCodePublic, isAdmin, accountCount, standalone, remoteAddress }) {
  if (enabled !== true) { return false; }
  if (shareCodePublic !== true && isAdmin !== true) { return false; }
  if (standalone && accountCount === 0 && !isLoopback(remoteAddress)) { return false; }
  return true;
}

function isLoopback(addr) {
  const a = String(addr || '');
  const bare = a.startsWith('::ffff:') ? a.slice(7) : a; // v4-mapped-in-v6
  return bare === '::1' || bare.startsWith('127.');
}

export function setup(mstream) {
  mstream.get('/api/v1/iroh/code', async (req, res) => {
    const enabled = config.program.iroh.enabled === true;
    const shared = mayShareCode({
      enabled,
      shareCodePublic: config.program.iroh.shareCodePublic === true,
      isAdmin: req.user?.admin === true,
      accountCount: db.getAllUsers().length,
      standalone: isBunStandalone,
      remoteAddress: req.socket?.remoteAddress,
    });
    if (!shared) {
      // Don't reveal the code; tell the client the feature isn't being
      // shared. Deliberately the same response for "not shared" and "not
      // yours to see from that address" — no probing signal.
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
