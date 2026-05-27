import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as shared from '../api/shared.js';
import { isActiveJukeboxToken } from '../api/remote.js';
import WebError from '../util/web-error.js';

// Partition a user's libraries by libraries.type. The music side (the
// pre-existing /api/v1/* + /rest/* surfaces) only ever sees `vpaths` —
// audio-book libraries are siphoned off into `audiobookVpaths`, which
// only the /api/* Audiobookshelf adapter reads. That single split is
// what makes audiobook libraries invisible to Subsonic + the default
// UI without touching every music endpoint. v1: hidden — revisit if
// Subsonic clients with audiobook support (Symfonium, etc.) ask for
// access to these libraries via /rest/*.
function partitionVpaths(libraries) {
  const vpaths = [];
  const audiobookVpaths = [];
  for (const l of libraries) {
    if (l.type === 'audio-books') {
      audiobookVpaths.push(l.name);
    } else {
      vpaths.push(l.name);
    }
  }
  return { vpaths, audiobookVpaths };
}

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

      // Get user's library names for the response. Audio-book libraries
      // are stripped — the login response feeds the music-side UI which
      // doesn't know about audiobooks. The Audiobookshelf adapter has
      // its own /api/login that returns the audiobookVpaths subset.
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      const { vpaths } = partitionVpaths(libraries);

      res.json({ vpaths, token });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    const allUsers = db.getAllUsers();

    // Handle No Users (public access mode)
    if (allUsers.length === 0) {
      const allLibs = db.getAllLibraries();
      const adminLocked = config.program.lockAdmin === true;
      // Spread the sentinel's actual users-table row first so per-user
      // columns (lastfm_user, lastfm_password, listenbrainz_token, …)
      // are present on req.user exactly the way they are for real-user
      // requests above. Endpoints that read those columns off req.user
      // (scrobbler.js, velvet-stubs.js /lastfm/status, etc.) then work
      // in public mode without per-endpoint DB lookups. Permission
      // flags below override whatever the sentinel row stored — the
      // sentinel's own allow_* defaults are 0 (see ensureAnonymousUser),
      // and we want them driven by adminLocked instead.
      const sentinel = db.getAnonymousUser() || {};
      const pubPart = partitionVpaths(allLibs);
      req.user = {
        ...sentinel,
        vpaths: pubPart.vpaths,
        audiobookVpaths: pubPart.audiobookVpaths,
        username: 'mstream-user',
        admin: !adminLocked,
        // Pin to the always-present anonymous sentinel row in the
        // users table. Per-user tables (user_metadata, playlists,
        // cue_points, …) all FK on users(id) NOT NULL, so a null id
        // here meant every write endpoint crashed in public mode.
        // The sentinel is filtered out of getAllUsers() so the
        // empty-check above still means "no real users".
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
      return next();
    }

    const token = req.body?.token || req.query?.token || req.headers?.['x-access-token'] || req.cookies?.['x-access-token'];
    if (!token) { throw new WebError('Authentication Error', 401); }
    req.token = token;

    const decoded = jwt.verify(token, config.program.secret);

    // Handle federation invite tokens
    if (decoded.invite && decoded.invite === true) {
      if (req.path === '/federation/invite/exchange') { return next(); }
      throw new WebError('Authentication Error', 401);
    }

    // Handle jukebox tokens
    if (decoded.jukebox === true && decoded.username) {
      // Verify the token belongs to an active jukebox session
      if (!isActiveJukeboxToken(token)) {
        throw new WebError('Jukebox session expired', 401);
      }

      const user = db.getUserByUsername(decoded.username);
      if (!user) { throw new WebError('Authentication Error', 401); }
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      const jbPart = partitionVpaths(libraries);
      req.user = {
        ...user,
        vpaths: jbPart.vpaths,
        audiobookVpaths: jbPart.audiobookVpaths,
        admin: false,
        allow_upload: 0,
        allow_mkdir: 0,
        allow_file_modify: 0,
        allow_server_audio: 0
      };
      return next();
    }

    if (!decoded.username) {
      throw new WebError('Authentication Error', 401);
    }

    const user = db.getUserByUsername(decoded.username);
    if (!user) {
      throw new WebError('Authentication Error', 401);
    }

    // Build user object with vpaths. Music libraries land on `vpaths`
    // (consumed by every pre-existing endpoint); audio-book libraries
    // land on `audiobookVpaths` (only the Audiobookshelf adapter reads
    // this).
    const libIds = db.getUserLibraryIds(user);
    const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
    const part = partitionVpaths(libraries);
    req.user = {
      ...user,
      vpaths: part.vpaths,
      audiobookVpaths: part.audiobookVpaths,
      admin: user.is_admin === 1
    };

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
