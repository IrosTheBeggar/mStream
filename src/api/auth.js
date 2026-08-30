import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as shared from '../api/shared.js';
import { isActiveJukeboxToken } from '../api/remote.js';
import * as federationAuth from './federation-auth.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  // When admin API is locked, force all server-level write permissions off.
  // This prevents any write operations even in public mode (no users).
  if (config.program.lockAdmin === true) {
    config.program.noUpload = true;
    config.program.noMkdir = true;
    config.program.noFileModify = true;
  }

  mstream.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      const user = db.getUserByUsername(req.body.username);
      if (!user) { throw new Error('user not found'); }

      await auth.authenticateUser(user.password, user.salt, req.body.password);

      const token = jwt.sign({ username: req.body.username }, config.program.secret);

      res.cookie('x-access-token', token, {
        maxAge: 157784630000, // 5 years in ms
        sameSite: 'Strict',
      });

      // Get user's library names for the response
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      const vpaths = libraries.map(l => l.name);

      res.json({ vpaths, token });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    // Handle federation keys FIRST — ordering is load-bearing. On a no-users
    // server the public-mode branch below hands EVERY request a full-access
    // user, so a federation request that reached it would silently escape its
    // library scoping. The key is a raw `fedk_…` credential (not a JWT), so
    // it rides its own header and never touches jwt.verify.
    const fedKey = req.headers['x-federation-key'];
    if (typeof fedKey === 'string' && fedKey.length > 0) {
      req.user = federationAuth.authenticateFederationKey(fedKey, req);
      return next();
    }

    // Handle No Users (public access mode)
    if (db.getAllUsers().length === 0) {
      req.user = buildPublicModeUser();
      return next();
    }

    const token = readToken(req);
    if (!token) { throw new WebError('Authentication Error', 401); }
    req.token = token;

    const decoded = verifyToken(token, req);

    // Handle jukebox tokens
    if (decoded.jukebox === true && decoded.username) {
      req.user = buildJukeboxUser(decoded, token);
      return next();
    }

    req.user = buildRealUser(decoded);

    // Handle Shared Tokens
    if (decoded.shareToken && decoded.shareToken === true) {
      const playlistItem = shared.lookupPlaylist(decoded.playlistId);

      if (
        req.path !== '/api/v1/download/shared' &&
        req.path !== '/api/v1/db/metadata' &&
        req.path.substring(0, 11) !== '/album-art/' &&
        playlistItem.playlist.indexOf(decodeURIComponent(req.path).slice(7)) === -1
      ) {
        throw new WebError('Authentication Error', 401);
      }

      req.sharedPlaylistId = decoded.playlistId;
    }

    next();
  });
}

// The token slots, in precedence order. ONE definition — the wall,
// resolveOptionalUser, and credentialsPresented must always agree on
// where a token can ride, or "present but invalid" and "absent" drift
// apart between the wall and the optional-auth endpoint.
function readToken(req) {
  return req.body?.token || req.query?.token || req.headers?.['x-access-token'] || req.cookies?.['x-access-token'];
}

// ── User builders ───────────────────────────────────────────────────────────
// Shared by the wall above and resolveOptionalUser below — ONE source of
// truth for what each credential kind resolves to. Behavior here is the
// wall's original inline logic, moved verbatim.

// The public-access-mode user (no real users in the DB).
function buildPublicModeUser() {
  const allLibs = db.getAllLibraries();
  const adminLocked = config.program.lockAdmin === true;
  // Spread the sentinel's actual users-table row first so per-user
  // columns (lastfm_user, lastfm_password, listenbrainz_token, …)
  // are present on req.user exactly the way they are for real-user
  // requests. Endpoints that read those columns off req.user
  // (scrobbler.js, velvet-stubs.js /lastfm/status, etc.) then work
  // in public mode without per-endpoint DB lookups. Permission
  // flags below override whatever the sentinel row stored — the
  // sentinel's own allow_* defaults are 0 (see ensureAnonymousUser),
  // and we want them driven by adminLocked instead.
  const sentinel = db.getAnonymousUser() || {};
  return {
    ...sentinel,
    vpaths: allLibs.map(l => l.name),
    username: 'mstream-user',
    admin: !adminLocked,
    // Pin to the always-present anonymous sentinel row in the
    // users table. Per-user tables (user_metadata, playlists,
    // cue_points, …) all FK on users(id) NOT NULL, so a null id
    // here meant every write endpoint crashed in public mode.
    // The sentinel is filtered out of getAllUsers() so the
    // empty-check still means "no real users".
    id: db.getAnonymousUserId(),
    allow_upload: adminLocked ? 0 : 1,
    allow_mkdir: adminLocked ? 0 : 1,
    allow_file_modify: adminLocked ? 0 : 1,
    // Mirrors the other permission flags: when the admin API is
    // locked, the single implicit user is demoted and loses the
    // write permissions AND server-audio access. When unlocked,
    // they're effectively admin, so the gate is bypassed anyway —
    // the value here only matters in the locked case.
    allow_server_audio: adminLocked ? 0 : 1
  };
}

// jwt.verify throws on a token we can't trust (malformed, bad signature,
// expired). That's a 401, not an unhandled error that falls through to a
// generic 500. Log the cause — an invalid token at the auth wall is a
// probing signal.
function verifyToken(token, req) {
  try {
    return jwt.verify(token, config.program.secret);
  } catch (err) {
    winston.warn(`Rejected invalid token from ${req.ip} on ${req.path}: ${err.message}`);
    throw new WebError('Authentication Error', 401);
  }
}

// A jukebox session's restricted user: real user's libraries, no writes,
// never admin. Verifies the token belongs to an ACTIVE jukebox session.
function buildJukeboxUser(decoded, token) {
  if (!isActiveJukeboxToken(token)) {
    throw new WebError('Jukebox session expired', 401);
  }
  const user = db.getUserByUsername(decoded.username);
  if (!user) { throw new WebError('Authentication Error', 401); }
  const libIds = db.getUserLibraryIds(user);
  const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
  return {
    ...user,
    vpaths: libraries.map(l => l.name),
    admin: false,
    allow_upload: 0,
    allow_mkdir: 0,
    allow_file_modify: 0,
    allow_server_audio: 0
  };
}

// A real user token → user object with vpaths.
function buildRealUser(decoded) {
  if (!decoded.username) {
    throw new WebError('Authentication Error', 401);
  }
  const user = db.getUserByUsername(decoded.username);
  if (!user) {
    throw new WebError('Authentication Error', 401);
  }
  const libIds = db.getUserLibraryIds(user);
  const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
  return {
    ...user,
    vpaths: libraries.map(l => l.name),
    admin: user.is_admin === 1
  };
}

// ── Optional-auth resolution ────────────────────────────────────────────────
// For routes mounted BEFORE the wall whose bottom layer is public (the
// layered GET /api/ in server-info.js). Same branch ORDER as the wall —
// federation first is load-bearing for exactly the reason documented there.
//
// Contract:
//   - no credentials at all → null (caller serves its public layer);
//   - share token → null (they exist to fetch one playlist, not to
//     identify a session; the wall path-gates them, this endpoint just
//     treats them as anonymous);
//   - presented-but-invalid token/key → throws the same 401 the wall
//     throws (403 for a federation key off its allowlist). A bad
//     credential must surface as an error, never silently downgrade to
//     the public layer — a client with an expired token needs the 401
//     to know to re-authenticate.
export function resolveOptionalUser(req) {
  const fedKey = req.headers['x-federation-key'];
  if (typeof fedKey === 'string' && fedKey.length > 0) {
    return federationAuth.authenticateFederationKey(fedKey, req);
  }

  if (db.getAllUsers().length === 0) { return buildPublicModeUser(); }

  const token = readToken(req);
  if (!token) { return null; }

  const decoded = verifyToken(token, req);
  if (decoded.jukebox === true && decoded.username) {
    return buildJukeboxUser(decoded, token);
  }
  if (decoded.shareToken === true) { return null; }
  return buildRealUser(decoded);
}

// Whether the request PRESENTED any credential (a federation key or a
// token in any slot), regardless of validity or what it resolves to.
// The layered /api/ uses this for its "the version is the anonymous
// probe's payload" rule: `server` appears only when this is false. Note
// the deliberate asymmetry with resolveOptionalUser: a share token
// resolves to null (anonymous data-wise) but still counts as presented.
export function credentialsPresented(req) {
  const fedKey = req.headers['x-federation-key'];
  if (typeof fedKey === 'string' && fedKey.length > 0) { return true; }
  return Boolean(readToken(req));
}
