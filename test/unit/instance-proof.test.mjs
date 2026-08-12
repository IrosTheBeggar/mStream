import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHALLENGE_HEADER,
  PROOF_HEADER,
  newChallenge,
  computeProof,
  verifyProof,
} from '../../src/util/instance-proof.js';

// Identity for the macOS relaunch probe. A false "yes" here opens the user's
// browser at whatever holds the port — handing it mStream's origin, and with it
// the localStorage JWT — so every ambiguous case must fail CLOSED.

test('a genuine server proves itself', () => {
  const nonce = 'a-per-boot-secret';
  const challenge = newChallenge();
  assert.equal(verifyProof(nonce, challenge, computeProof(nonce, challenge)), true);
});

test('an impostor that never read the 0600 file cannot forge a proof', () => {
  const challenge = newChallenge();
  // The squatter sees only the challenge — the nonce never crosses the wire.
  const forged = computeProof('guessed-wrong-secret', challenge);
  assert.equal(verifyProof('the-real-secret', challenge, forged), false);
});

test('a proof is bound to its challenge, so an observed proof cannot be replayed', () => {
  const nonce = 'a-per-boot-secret';
  const captured = computeProof(nonce, newChallenge());
  // Next launch issues a fresh challenge; the old proof must not satisfy it.
  assert.equal(verifyProof(nonce, newChallenge(), captured), false);
});

test('the proof does not disclose the nonce', () => {
  const nonce = 'a-per-boot-secret';
  const challenge = newChallenge();
  const proof = computeProof(nonce, challenge);
  assert.ok(!proof.includes(nonce), 'proof must not contain the secret it is keyed by');
});

test('challenges are unique per probe', () => {
  const seen = new Set(Array.from({ length: 200 }, () => newChallenge()));
  assert.equal(seen.size, 200, 'a repeated challenge would make proofs replayable');
});

test('missing or malformed inputs fail closed rather than throwing', () => {
  const nonce = 'a-per-boot-secret';
  const challenge = newChallenge();
  // No nonce on disk (unwritable dbDirectory) => nothing to prove against.
  assert.equal(computeProof(null, challenge), null);
  assert.equal(computeProof('', challenge), null);
  assert.equal(computeProof(nonce, ''), null);
  // A server that answered with no proof header at all.
  assert.equal(verifyProof(nonce, challenge, undefined), false);
  assert.equal(verifyProof(nonce, challenge, null), false);
  // Non-string header values (node lowercases + may array-ify duplicates).
  assert.equal(verifyProof(nonce, challenge, ['a', 'b']), false);
  // Length mismatch must not throw out of timingSafeEqual.
  assert.doesNotThrow(() => verifyProof(nonce, challenge, 'short'));
  assert.equal(verifyProof(nonce, challenge, 'short'), false);
});

test('an oversized challenge is refused rather than HMACed', () => {
  // The responder runs ahead of the auth wall, so cap what an unauthenticated
  // caller can make us hash.
  assert.equal(computeProof('secret', 'x'.repeat(257)), null);
  assert.ok(computeProof('secret', 'x'.repeat(256)));
});

test('header names stay lowercase — node/bun normalize incoming headers', () => {
  // req.headers[...] lookups only match lowercase; a capitalized constant here
  // would silently never fire, disabling the probe with no error anywhere.
  assert.equal(CHALLENGE_HEADER, CHALLENGE_HEADER.toLowerCase());
  assert.equal(PROOF_HEADER, PROOF_HEADER.toLowerCase());
});
