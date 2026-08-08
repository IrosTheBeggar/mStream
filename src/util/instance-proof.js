// Proof-of-identity for the macOS relaunch probe (see util/mac-app-launch.js).
//
// THE QUESTION: a second double-click finds the port already taken. If that is
// our own server, the right outcome is "open the browser at it and exit 0"; if
// it is anything else, we must refuse — pointing the user's browser at a
// stranger hands them mStream's ORIGIN, and the web client keeps its JWT in
// localStorage (webapp/velvet/app.js: 'ms2_token'), which is origin-scoped. So
// a wrong "yes" leaks the session; a wrong "no" is a harmless dialog. Fail closed.
//
// THE ROOT OF TRUST IS THE FILESYSTEM, not crypto: the running server writes a
// fresh random nonce to <dbDirectory>/.instance-nonce with mode 0600, so only
// the same OS user can read it. Everything here just carries that fact across
// an HTTP connection whose far end is, by definition, not yet trusted.
//
// DIRECTION MATTERS. The obvious design — probe sends the nonce, server says
// "match" — is broken twice over: the probe would hand the secret to whatever
// holds the port (including the impostor it is trying to detect), and a
// squatter could simply reply "match" unconditionally, since the header name is
// public in this file. So the SERVER proves knowledge and the CLIENT supplies
// the challenge: the probe sends fresh random bytes, the server returns
// HMAC(nonce, challenge), and the nonce itself never crosses the wire. A
// squatter that never read the 0600 file cannot produce that value, and a
// replayed old proof cannot match a fresh challenge.
//
// This also removes any need to gate the response on the caller being loopback:
// there is no longer a secret to withhold, so the probe works for explicit
// (non-wildcard) bind addresses, where the server sees its own probe arrive
// from a LAN address rather than 127.0.0.1.
import crypto from 'crypto';

// Request header carrying the probe's random challenge; response header
// carrying the server's HMAC over it. Absent a challenge, the server emits
// nothing at all — it never volunteers identity to an unsolicited request.
export const CHALLENGE_HEADER = 'x-mstream-challenge';
export const PROOF_HEADER = 'x-mstream-proof';

// Bounds the work an unauthenticated caller can ask of us: this middleware runs
// ahead of the auth wall (the probe has no credentials), so cap the input we
// are willing to HMAC. Comfortably above the 22-char challenge we generate.
const MAX_CHALLENGE_LENGTH = 256;

export function newChallenge() {
  return crypto.randomBytes(16).toString('base64url');
}

// HMAC-SHA256 over the challenge, keyed by the per-boot nonce. Returns null for
// unusable input so callers can fail closed rather than proving something about
// an empty key.
export function computeProof(nonce, challenge) {
  if (!nonce || !challenge) { return null; }
  if (typeof challenge !== 'string' || challenge.length > MAX_CHALLENGE_LENGTH) { return null; }
  return crypto.createHmac('sha256', nonce).update(challenge).digest('base64url');
}

// Constant-time compare. timingSafeEqual throws on length mismatch, so guard
// that first — and treat any missing/!== length value as a failure, never a throw.
export function verifyProof(nonce, challenge, presentedProof) {
  const expected = computeProof(nonce, challenge);
  if (!expected || typeof presentedProof !== 'string') { return false; }
  const a = Buffer.from(expected);
  const b = Buffer.from(presentedProof);
  if (a.length !== b.length) { return false; }
  return crypto.timingSafeEqual(a, b);
}
