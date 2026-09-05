// Federation GUEST tokens — the credential that lets a key holder's own
// device (the mobile app) reach a peer directly, without the standing
// `fedk_` key ever leaving the parent server.
//
// A guest token is a short-lived JWT the PEER signs for one of its minted
// keys, on request from that key's holder (POST /api/v1/federation/guest —
// api/federation.js — callable only with a key that has completed the pipe
// handshake, which in practice means: by the parent, over the bridge). The
// parent hands the token to its device together with the peer's endpoint
// ticket (the `mstrfedg1:` guest ticket, docs/federation-guest-ticket.md);
// the device then dials the peer's federation endpoint itself, presents the
// token on the first bi-stream (state/federation.js), and authenticates
// every HTTP request inside the pipe with it — through the ordinary
// `?token=` / `x-access-token` slots, because it IS a JWT signed with this
// server's secret (api/auth.js routes it to api/federation-auth.js).
//
// What it resolves to: the key's synthetic read-only user — same library
// grants, same route allowlist, same bandwidth caps (guests share the key's
// pool). What differs from the key:
//   - no TOFU. Phones dial from ephemeral endpoints, so there is nothing
//     stable to bind; expiry is the bound instead (GUEST_TOKEN_TTL_MS).
//   - revocation is through the key: deleting (or expiring) the key kills
//     every guest at its next handshake or request, and severs live pipes.
//   - a guest cannot mint further guests (the mint route refuses).
//
// The claims are deliberately minimal: `federationGuest: true` marks the
// kind, `federationKeyId` names the key. No `username`, so a guest token
// presented as an ordinary user token dies in the wall's real-user branch
// (401), and an ordinary user token never carries the guest claim.

import jwt from 'jsonwebtoken';
import * as config from './config.js';

// Test override, same pattern as MSTREAM_TEST_FED_FLUSH_MS: production
// installs should never set it. 24h: long enough that a device refreshes a
// handful of times a day (the parent re-mints past three quarters of the
// lifetime), short enough that a token lifted off a phone is worthless by
// the next day.
export const GUEST_TOKEN_TTL_MS = Number(process.env.MSTREAM_TEST_FED_GUEST_TTL_MS) || 24 * 60 * 60 * 1000;

// Sign a guest token for `keyRow`. Returns { token, expiresAt } with the
// expiry as ISO — read back out of the signed token, so the two can never
// disagree by a rounding second.
export function mintGuestToken(keyRow, { ttlMs = GUEST_TOKEN_TTL_MS } = {}) {
  const token = jwt.sign(
    { federationGuest: true, federationKeyId: keyRow.id },
    config.program.secret,
    { expiresIn: Math.max(1, Math.ceil(ttlMs / 1000)) },
  );
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

// Whether a token CLAIMS to be a guest token — a plain decode, no signature
// check. The auth wall uses this to route a token to the guest branch ahead
// of the public-mode branch without verifying ordinary user tokens twice;
// the guest branch then verifies for real.
export function looksLikeGuestToken(token) {
  if (typeof token !== 'string' || token.length === 0) { return false; }
  const decoded = jwt.decode(token);
  return Boolean(decoded && typeof decoded === 'object' && decoded.federationGuest === true);
}

// Verify a guest token (signature, expiry, shape). Returns { keyId, exp }
// or throws — the caller turns that into its own 401 / handshake NO.
export function verifyGuestToken(token) {
  const decoded = jwt.verify(token, config.program.secret);
  if (!decoded || typeof decoded !== 'object'
    || decoded.federationGuest !== true
    || !Number.isInteger(decoded.federationKeyId)) {
    throw new Error('not a federation guest token');
  }
  return { keyId: decoded.federationKeyId, exp: decoded.exp };
}
