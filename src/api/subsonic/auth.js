/**
 * Subsonic API authentication middleware.
 *
 * Subsonic clients identify themselves with a combination of:
 *   - `u=<username>` + `p=<plaintext-or-enc:HEX>`
 *   - `u=<username>` + `t=<md5(password+salt)>` + `s=<salt>`  (token)
 *   - `apiKey=<opaque-key>` (OpenSubsonic extension)
 *
 * We support plaintext / `enc:HEX` / API key. Token auth requires the server
 * to know the plaintext password (to compute `md5(plaintext + salt)`), which
 * mStream doesn't store — it only keeps PBKDF2 hashes. Users who want token
 * auth use an API key instead. See docs/dlna-todo.md equivalent for Subsonic
 * deferred items.
 *
 * On success, populates `req.user` in the same shape other mStream routes
 * expect: `{ username, id, vpaths, admin, allow_upload, allow_mkdir,
 * allow_file_modify }`.
 */

import crypto from 'node:crypto';
import winston from 'winston';
import * as db from '../../db/manager.js';
import * as auth from '../../util/auth.js';
import { decryptSubsonicPassword } from '../../util/subsonic-password.js';
import { SubErr } from './response.js';

// Decode a Subsonic-style `enc:HEX` hex-encoded password. Clients that don't
// want to send plaintext (or care about characters that'd need URL-escaping)
// hex-encode the password instead. Returns null on malformed input.
function decodeEncHex(pStr) {
  if (!pStr?.startsWith('enc:')) { return pStr; }
  const hex = pStr.slice(4);
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) { return null; }
  try { return Buffer.from(hex, 'hex').toString('utf8'); }
  catch { return null; }
}

// Look up an API key. Side-effect: updates `last_used` timestamp. Returns
// the full user row (for subsequent req.user population) or null.
//
// Excludes the anonymous sentinel by FK in the JOIN: the sentinel must
// never be authenticated-as via any path other than the auth.js no-users
// branch. The mint-key admin endpoint already can't target it (its
// getUserByUsername lookup filters the sentinel out), but excluding it
// here too means a hypothetical row planted directly into user_api_keys
// — bypassing the API surface entirely — still can't authenticate.
function userForApiKey(key) {
  const d = db.getDB();
  const row = d.prepare(`
    SELECT u.* FROM users u
    JOIN user_api_keys k ON k.user_id = u.id
    WHERE k.key = ? AND u.is_anonymous_sentinel = 0
  `).get(key);
  if (!row) { return null; }
  d.prepare('UPDATE user_api_keys SET last_used = datetime(\'now\') WHERE key = ?').run(key);
  return row;
}

async function userForPassword(username, password) {
  if (!username || !password) { return null; }
  const user = db.getUserByUsername(username);
  if (!user) { return null; }
  try {
    await auth.authenticateUser(user.password, user.salt, password);
    return user;
  } catch {
    return null;
  }
}

function populateReqUser(req, userRow) {
  const libIds = db.getUserLibraryIds(userRow);
  // Subsonic clients don't speak audiobook semantics in v1 — strip
  // audio-book libraries from vpaths so getMusicFolders / getArtists /
  // search3 don't surface them. Same partition rule as mStream's
  // primary auth middleware (see src/api/auth.js#partitionVpaths).
  const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id) && l.type !== 'audio-books');
  req.user = {
    id:                 userRow.id,
    username:           userRow.username,
    vpaths:             libraries.map(l => l.name),
    admin:              !!userRow.is_admin,
    allow_upload:       !!userRow.allow_upload,
    allow_mkdir:        !!userRow.allow_mkdir,
    allow_file_modify:  userRow.allow_file_modify == null ? true : !!userRow.allow_file_modify,
  };
}

/**
 * Express middleware. Verifies Subsonic credentials on every /rest request.
 * Populates req.user on success; emits a Subsonic error envelope on failure
 * and terminates the request.
 */
export async function subsonicAuth(req, res, next) {
  // Subsonic allows credentials via query string or form body; we accept both.
  const q = { ...req.query, ...(req.body || {}) };

  // 1. API key (preferred modern path)
  if (q.apiKey) {
    const user = userForApiKey(String(q.apiKey));
    if (!user) { return SubErr.BAD_CREDENTIALS(req, res); }
    populateReqUser(req, user);
    return next();
  }

  // 2. Token auth (md5(password + salt)). Requires server-side plaintext;
  // mStream's main password is PBKDF2 (one-way) so we use the V35 opt-in
  // Subsonic-specific password column, populated via the mobile-clients
  // panel (PUT /api/v1/user/subsonic-password) or the admin API.
  if (q.t && q.s) {
    const username = q.u ? String(q.u) : null;
    const user = username ? db.getUserByUsername(username) : null;
    if (!user || !user.subsonic_password_encrypted) {
      // Still log the attempt — admins want to see "this user's client
      // is trying token auth" so they can prompt the user to set a
      // Subsonic password.
      recordTokenAuthAttempt({
        username,
        client:   q.c ? String(q.c) : null,
        at:       Date.now(),
        ua:       req.get?.('user-agent') || null,
      });
      return SubErr.TOKEN_UNSUPPORTED(req, res);
    }
    let plainSubsonic;
    try {
      plainSubsonic = decryptSubsonicPassword(user.subsonic_password_encrypted);
    } catch (err) {
      // Decrypt failed — usually because subsonicSecret rotated and
      // the existing ciphertext is no longer readable. Treat as
      // "no Subsonic password set" so the user gets the guided
      // error path.
      winston.warn('[subsonic] subsonic-password decrypt failed; user must re-set', {
        username, err: err.message,
      });
      return SubErr.TOKEN_UNSUPPORTED(req, res);
    }
    const expected = crypto.createHash('md5').update(plainSubsonic + String(q.s)).digest('hex');
    if (expected !== String(q.t)) { return SubErr.BAD_CREDENTIALS(req, res); }
    populateReqUser(req, user);
    return next();
  }

  // 3. Plaintext / enc:HEX password. Try the main PBKDF2 password
  // first; on miss, fall back to a constant-time compare against the
  // V35 Subsonic-specific password (decrypted on the spot). The
  // fallback means a Subsonic client sending u/p doesn't need to know
  // which password to send — either works.
  if (q.u && q.p) {
    const plain = decodeEncHex(String(q.p));
    if (plain === null) { return SubErr.BAD_CREDENTIALS(req, res); }
    const username = String(q.u);
    try {
      const user = await userForPassword(username, plain);
      if (user) {
        populateReqUser(req, user);
        return next();
      }
      // PBKDF2 missed — try the Subsonic-specific password if set.
      const candidate = db.getUserByUsername(username);
      if (candidate?.subsonic_password_encrypted) {
        let plainSubsonic;
        try { plainSubsonic = decryptSubsonicPassword(candidate.subsonic_password_encrypted); }
        catch { plainSubsonic = null; }
        if (plainSubsonic && constantTimeEqual(plain, plainSubsonic)) {
          populateReqUser(req, candidate);
          return next();
        }
      }
      return SubErr.BAD_CREDENTIALS(req, res);
    } catch (err) {
      winston.error('[subsonic] auth error', { stack: err });
      return SubErr.GENERIC(req, res, 'Authentication error.');
    }
  }

  return SubErr.MISSING_PARAM(req, res, 'u/p or apiKey');
}

// Constant-time compare for the plaintext fallback. Avoid timing-leak
// signals about how many leading bytes matched the stored Subsonic
// password.
function constantTimeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) { return false; }
  return crypto.timingSafeEqual(ab, bb);
}

// ── Token-auth attempt ring buffer ─────────────────────────────────────────
//
// Real-world Subsonic clients often default to token auth (md5(password +
// salt) + salt). mStream can't support that — we store PBKDF2 hashes, not
// the plaintext needed to compute the server-side digest. We reject with
// error 41, but users whose clients silently retry with token-only auth
// get a confusing "invalid credentials" loop with no guidance.
//
// Log each attempt in a small ring buffer so the admin panel can show
// "these users tried token auth recently — mint them an API key so their
// client starts working." Process-local; not persisted across restarts.

const TOKEN_ATTEMPT_LIMIT = 50;
const tokenAuthAttempts = [];

function recordTokenAuthAttempt(entry) {
  tokenAuthAttempts.push(entry);
  if (tokenAuthAttempts.length > TOKEN_ATTEMPT_LIMIT) {
    tokenAuthAttempts.shift();
  }
}

export function listTokenAuthAttempts() {
  // Return most-recent first. Copy the array so callers can't mutate.
  return tokenAuthAttempts.slice().reverse();
}

export function clearTokenAuthAttempts() {
  tokenAuthAttempts.length = 0;
}

// ── API key helpers (used by admin endpoints) ───────────────────────────────
// (crypto already imported at top of file)

export function generateApiKey(userId, name) {
  const key = crypto.randomBytes(24).toString('base64url');
  db.getDB().prepare(
    'INSERT INTO user_api_keys (user_id, key, name) VALUES (?, ?, ?)'
  ).run(userId, key, name || null);
  return key;
}

export function listApiKeys(userId) {
  return db.getDB().prepare(
    'SELECT id, name, created_at, last_used FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

export function revokeApiKey(userId, keyId) {
  return db.getDB().prepare(
    'DELETE FROM user_api_keys WHERE user_id = ? AND id = ?'
  ).run(userId, keyId).changes > 0;
}
