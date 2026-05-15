/**
 * AES-256-GCM encrypt/decrypt for the opt-in Subsonic-specific
 * password column added in V35. See src/db/schema.js SCHEMA_V35 for
 * the column definition and the design rationale.
 *
 *   plaintext  →  encryptSubsonicPassword(p)  →  base64 string for
 *                                                 users.subsonic_password_encrypted
 *   stored     →  decryptSubsonicPassword(s)  →  plaintext (or throws
 *                                                 if tampered / wrong key)
 *
 * Key derivation: HKDF-SHA256 from `config.program.subsonicSecret`
 * (separate from `config.program.secret` for independent rotation)
 * with a fixed info label so the same secret can derive other keys
 * later without collision.
 *
 * Storage format: 12-byte IV || ciphertext || 16-byte GCM auth tag,
 * base64-encoded. Per-encryption IV (random) means the same plaintext
 * encrypts to a different ciphertext each time — no equality leak.
 *
 * Tamper detection: GCM's auth tag is verified on decrypt. Any byte
 * mutation (IV, ciphertext, or tag) raises an error rather than
 * returning silent garbage.
 *
 * Secret rotation: changing config.program.subsonicSecret makes every
 * existing ciphertext unreadable — decrypt() will throw. The Subsonic
 * auth handler treats decrypt errors as "no Subsonic password set"
 * and points the user at the mobile-clients panel to re-set.
 */

import crypto from 'node:crypto';
import * as config from '../state/config.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;     // 96-bit nonce — recommended for GCM
const TAG_BYTES = 16;    // 128-bit auth tag (GCM default)
const HKDF_INFO = Buffer.from('subsonic-password-v1');

function deriveKey() {
  const secret = config.program?.subsonicSecret;
  if (!secret) {
    throw new Error(
      'subsonic-password: config.program.subsonicSecret is missing. ' +
      'Boot mStream once with the V35-aware setup() so the secret gets ' +
      'auto-generated, or set it manually in the config file.'
    );
  }
  // The secret is base64 from asyncRandom(128) → 128 bytes of entropy
  // before encoding. HKDF expands+contracts it to a stable 32-byte
  // AES key. Empty salt is fine; the secret is the entropy source.
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'base64'),
    Buffer.alloc(0),
    HKDF_INFO,
    KEY_BYTES,
  ));
}

/**
 * Encrypt a Subsonic password for storage in
 * users.subsonic_password_encrypted. Returns a base64 string.
 */
export function encryptSubsonicPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSubsonicPassword: plaintext must be a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a stored Subsonic password back to plaintext. Throws on:
 *   - empty / null input
 *   - malformed base64
 *   - too-short payload (missing IV or tag)
 *   - GCM auth-tag verification failure (tampering OR wrong key,
 *     e.g. after a subsonicSecret rotation)
 */
export function decryptSubsonicPassword(stored) {
  if (!stored) {
    throw new Error('decryptSubsonicPassword: empty input');
  }
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('decryptSubsonicPassword: stored value too short to be valid');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
