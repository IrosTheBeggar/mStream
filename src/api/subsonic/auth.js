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

import winston from 'winston';
import * as db from '../../db/manager.js';
import * as auth from '../../util/auth.js';
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
function userForApiKey(key) {
  const d = db.getDB();
  const row = d.prepare(`
    SELECT u.* FROM users u
    JOIN user_api_keys k ON k.user_id = u.id
    WHERE k.key = ?
  `).get(key);
  if (!row) { return null; }
  d.prepare('UPDATE user_api_keys SET last_used = datetime(\'now\') WHERE key = ?').run(key);
  return row;
}

async function userForPassword(username, password) {
  if (!username || !password) { return null; }
  const user = db.getUserByUsername(username);
  if (!user) { return null; }

  // Check the Subsonic-specific password first if the admin has set one.
  // Stored plaintext because Subsonic's u/p flow has no way to do a
  // challenge/response handshake at the protocol level — the client sends
  // plaintext, we compare plaintext. The admin UI and the
  // /api/v1/admin/users/subsonic-password docs spell out the tradeoff.
  if (user.subsonic_password && user.subsonic_password === password) {
    return user;
  }

  // Fall through to the mStream password (PBKDF2 hash). Stays compatible
  // with users who haven't set a Subsonic-specific password yet.
  try {
    await auth.authenticateUser(user.password, user.salt, password);
    return user;
  } catch {
    return null;
  }
}

function populateReqUser(req, userRow) {
  const libIds = db.getUserLibraryIds(userRow);
  const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
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

  // 2. Token auth — not supported (server-side plaintext not available).
  if (q.t && q.s) {
    // Record the attempt so the admin panel can surface "this user's
    // client is trying token auth; mint them an API key" warnings.
    recordTokenAuthAttempt({
      username: q.u ? String(q.u) : null,
      client:   q.c ? String(q.c) : null,
      at:       Date.now(),
      ua:       req.get?.('user-agent') || null,
    });
    return SubErr.TOKEN_UNSUPPORTED(req, res);
  }

  // 3. Plaintext / enc:HEX password
  if (q.u && q.p) {
    const plain = decodeEncHex(String(q.p));
    if (plain === null) { return SubErr.BAD_CREDENTIALS(req, res); }
    try {
      const user = await userForPassword(String(q.u), plain);
      if (!user) { return SubErr.BAD_CREDENTIALS(req, res); }
      populateReqUser(req, user);
      return next();
    } catch (err) {
      winston.error('[subsonic] auth error', { stack: err });
      return SubErr.GENERIC(req, res, 'Authentication error.');
    }
  }

  return SubErr.MISSING_PARAM(req, res, 'u/p or apiKey');
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

import crypto from 'node:crypto';

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
