// Seed-list signing: the remote seeds/discovery-seeds.json is the one
// remotely-fetched input that shapes who a fresh server trusts, so it is
// ed25519-signed by an offline key that never touches the repo or CI. This
// closes the gap the v1 posture documented: a hijacked GitHub account, a
// tampering mirror (operators may point seedListUrl elsewhere), or a TLS
// middlebox can no longer swap the seed set — they'd have to steal the
// signing key itself. The baked DEFAULT_SEEDS need no signature: they ship
// inside the reviewed, released code.
//
// Scheme (matches the sidecar's gossip-signing conventions):
//   - canonical pipe-separated string over seq + every entry's fields —
//     both signer and verifier BUILD it from the structured document, so
//     there is no canonical-JSON problem; '|' and ',' are rejected in
//     fields so no two documents can canonicalize identically;
//   - `seq` is a monotonic counter bumped on every signing. The fetcher
//     rejects a fetched list older than its cached one, so a replayed old
//     (validly signed) list can't resurrect a rotated-out seed;
//   - signature is embedded in the document (single fetch, no sidecar-file
//     skew) and old clients ignore the extra fields (version stays 1).
//
// This module is deliberately pure (node:crypto only — no config, no
// winston) so scripts/sign-discovery-seeds.mjs and the tests can share the
// exact canonicalization with the runtime verifier.

import crypto from 'crypto';

// The mStream project seed-list public key (SPKI, base64). The private half
// lives offline with the maintainer — NOT in this repo, NOT in CI secrets.
export const SEEDS_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEApefSH8q8tqaFQ065BfI6I8ewwbq7HwvGFyUBAnxZY5k=';

function publicKey() {
  // Test override: hermetic suites sign their stub lists with a throwaway
  // key and point the spawned server here. Anyone who can set a server's
  // environment already owns the process, so this adds no attack surface.
  const b64 = process.env.MSTREAM_TEST_SEEDS_PUBKEY || SEEDS_PUBLIC_KEY_B64;
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

// The exact bytes that get signed. Field order inside an entry and entry
// order in the list are both significant (they're part of the statement
// "this is the seed list").
export function canonicalSeedListString(doc) {
  if (!Number.isInteger(doc.seq) || doc.seq < 0) {
    throw new Error('seed list needs a non-negative integer `seq`');
  }
  if (!Array.isArray(doc.seeds)) { throw new Error('seed list needs a `seeds` array'); }
  const parts = ['mstream-discovery-seeds-v1', `seq:${doc.seq}`];
  for (const s of doc.seeds) {
    const fields = [s.name || '', s.endpointId || '', s.ticket || ''];
    for (const f of fields) {
      if (typeof f !== 'string' || f.includes('|') || f.includes(',')) {
        throw new Error("seed entry fields must be strings without '|' or ','");
      }
    }
    parts.push(fields.join(','));
  }
  return parts.join('|');
}

// Throws with a specific reason when the document is unsigned, malformed,
// or fails verification; returns quietly when it's genuine.
export function verifySeedList(doc) {
  if (!doc || typeof doc !== 'object') { throw new Error('not an object'); }
  if (doc.version !== 1) { throw new Error(`unsupported version ${doc.version}`); }
  if (typeof doc.signature !== 'string' || doc.signature.length === 0) {
    throw new Error('missing signature');
  }
  const canonical = canonicalSeedListString(doc);
  const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'),
    publicKey(), Buffer.from(doc.signature, 'base64'));
  if (!ok) { throw new Error('signature verification failed'); }
}

// Returns a NEW document with the signature over the given doc's canonical
// form. Used by scripts/sign-discovery-seeds.mjs and the test suites.
export function signSeedList(doc, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const canonical = canonicalSeedListString(doc);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64');
  return { ...doc, signature };
}
