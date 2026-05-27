// Audiobookshelf-side auth bridge.
//
// Reuses mStream's existing JWT secret + PBKDF2-stored passwords so a
// user only ever has one credential set. The token format is the same
// JWT mStream issues for its own login endpoint — only the wire wrapper
// differs (Audiobookshelf clients send `Authorization: Bearer <jwt>`
// or `?token=<jwt>`, vs mStream's cookie / `x-access-token` header).
//
// Token acceptance is intentionally permissive: header first, query
// second. The mobile apps fall back to query-string tokens when
// connecting to the WebSocket (where custom headers aren't always
// possible) and for media-streaming URLs that are pasted into the
// system audio player.

import jwt from 'jsonwebtoken';
import * as auth from '../../util/auth.js';
import * as config from '../../state/config.js';
import * as db from '../../db/manager.js';

export function extractToken(req) {
  const header = req.headers?.authorization;
  if (header && /^Bearer\s+(.+)$/i.test(header)) {
    return RegExp.$1.trim();
  }
  if (req.query?.token) { return String(req.query.token); }
  if (req.headers?.['x-access-token']) { return String(req.headers['x-access-token']); }
  if (req.cookies?.['x-access-token']) { return String(req.cookies['x-access-token']); }
  return null;
}

export async function verifyCredentials(username, password) {
  const user = db.getUserByUsername(username);
  if (!user) { return null; }
  try {
    await auth.authenticateUser(user.password, user.salt, password);
    return user;
  } catch {
    return null;
  }
}

export function issueToken(username) {
  // Same secret + same payload shape as src/api/auth.js — a token issued
  // here is also valid against mStream's own login-gated routes (the
  // user might use mStream's web UI from the same browser).
  return jwt.sign({ username }, config.program.secret);
}

// Express middleware. Sets req.user with `vpaths` (music) and
// `audiobookVpaths` (audio-books) so downstream handlers can scope by
// type. We always populate from a fresh DB read so a JWT issued before
// a user's library access changed picks up the latest grants.
export function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }
  let decoded;
  try {
    decoded = jwt.verify(token, config.program.secret);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (!decoded?.username) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const user = db.getUserByUsername(decoded.username);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  const libIds = db.getUserLibraryIds(user);
  const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
  const audiobookLibs = libraries.filter(l => l.type === 'audio-books');
  const musicLibs     = libraries.filter(l => l.type !== 'audio-books');
  req.user = {
    ...user,
    vpaths:           musicLibs.map(l => l.name),
    audiobookVpaths:  audiobookLibs.map(l => l.name),
    audiobookLibIds:  audiobookLibs.map(l => l.id),
    audiobookLibs,
    admin: user.is_admin === 1,
  };
  req.token = token;
  next();
}
