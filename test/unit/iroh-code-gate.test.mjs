// The pairing-code gate (src/api/iroh.js mayShareCode) — the code embeds the
// Iroh connect secret, so who may fetch it is security policy, pinned here.
//
// The load-bearing case is the adversarial review's fresh-install hole: a
// standalone desktop bundle's first-run config enables Quick Connect, binds
// every interface, and (with zero accounts) the auth wall hands every request
// the admin sentinel — so without the standalone+no-accounts loopback clause,
// any LAN device could fetch a secret granting a persistent remote tunnel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayShareCode } from '../../src/api/iroh.js';

// Fresh desktop install: public mode makes every caller "admin", config has
// shareCodePublic on. Only the owner's own machine may see the code.
const freshDesktop = {
  enabled: true,
  shareCodePublic: true,
  isAdmin: true,
  accountCount: 0,
  standalone: true,
};

test('fresh desktop install: loopback callers get the code', () => {
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '127.0.0.1' }), true);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '::1' }), true);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '::ffff:127.0.0.1' }), true);
  // Whole 127/8, and the v4-mapped form of it, are loopback.
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '127.0.0.53' }), true);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '::ffff:127.1.2.3' }), true);
});

test('fresh desktop install: LAN peers are refused the code', () => {
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '192.168.1.44' }), false);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '::ffff:192.168.1.44' }), false);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: 'fe80::1234' }), false);
  // Absent/undefined socket address must fail closed, not open.
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: undefined }), false);
  assert.equal(mayShareCode({ ...freshDesktop, remoteAddress: '' }), false);
});

test('desktop install with a real account: normal auth rules resume', () => {
  // Once an account exists the auth wall requires login before this route,
  // so a LAN address with admin/shareCodePublic is the owner's own device.
  assert.equal(
    mayShareCode({ ...freshDesktop, accountCount: 1, remoteAddress: '192.168.1.44' }),
    true,
  );
});

test('non-standalone (source/Docker/demo) keeps the documented public-demo behavior', () => {
  // iroh is never auto-enabled outside the desktop bundle — a no-users demo
  // server sharing its code remotely is an operator choice, not a default.
  assert.equal(
    mayShareCode({ ...freshDesktop, standalone: false, remoteAddress: '203.0.113.9' }),
    true,
  );
});

test('feature and permission gates still precede everything', () => {
  assert.equal(mayShareCode({ ...freshDesktop, enabled: false, remoteAddress: '127.0.0.1' }), false);
  assert.equal(
    mayShareCode({
      enabled: true, shareCodePublic: false, isAdmin: false,
      accountCount: 3, standalone: false, remoteAddress: '127.0.0.1',
    }),
    false,
    'no shareCodePublic and not admin: never shared, even from loopback',
  );
  assert.equal(
    mayShareCode({
      enabled: true, shareCodePublic: false, isAdmin: true,
      accountCount: 3, standalone: true, remoteAddress: '10.0.0.5',
    }),
    true,
    'authenticated admin on a server with accounts: shared as before',
  );
});
