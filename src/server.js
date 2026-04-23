import winston from 'winston';
import express from 'express';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';
import { createRequire } from 'module';

import * as dbApi from './api/db.js';
import * as playlistApi from './api/playlist.js';
import * as authApi from './api/auth.js';
import * as fileExplorerApi from './api/file-explorer.js';
import * as downloadApi from './api/download.js';
import * as adminApi from './api/admin.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as syncthing from './state/syncthing.js';
import * as federationApi from './api/federation.js';
// scanner.js removed — parser now writes directly to SQLite
import * as ytdlApi from './api/ytdl.js';
import * as dlnaApi from './api/dlna.js';
import * as dlnaSsdp from './dlna/ssdp.js';
import * as dlnaServer from './dlna/dlna-server.js';
import * as subsonicApi from './api/subsonic/index.js';
import * as subsonicServer from './subsonic/subsonic-server.js';
import * as userApiKeysApi from './api/user-api-keys.js';
import * as serverPlaybackApi from './api/server-playback.js';
import * as albumArtApi from './api/album-art.js';
import * as waveformApi from './api/waveform.js';
import * as lyricsApi from './api/lyrics.js';
import * as lyricsLrclib from './api/lyrics-lrclib.js';
// Velvet UI modules — dynamically imported only when ui='velvet' is active
import WebError from './util/web-error.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

let mstream;
let server;

export async function serveIt(configFile) {
  mstream = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    process.exit(1);
  }

  // Logging
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory);
  }

  // Set server
  if (config.program.ssl && config.program.ssl.cert && config.program.ssl.key) {
    try {
      config.setIsHttps(true);
      server = https.createServer({
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert),
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    config.setIsHttps(false);
    server = http.createServer();
  }

  // Magic Middleware Things
  mstream.use(cookieParser());
  mstream.use(express.json({ limit: config.program.maxRequestSize }));
  mstream.use(express.urlencoded({ extended: true }));
  mstream.use((req, res, next) => {
    // CORS
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
  });

  // Setup DB
  dbManager.initDB();

  // remove trailing slashes, needed for relative URLs on the webapp
  mstream.get('{*path}', (req, res, next) => {
    // check if theres more than one slash at the end of the URL
    if (req.path.endsWith('//')) {
      // find all trailing slashes at the end of the url
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString =
        req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(
        302,
        req.path.slice(0, (matchEnd[0].length - 1) * -1) + queryString
      );
    }
    next();
  });

  // Block access to admin page if necessary
  mstream.get('/admin', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    if (dbManager.getAllUsers().length === 0) {
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch (_err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/admin/index.html', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    next();
  });

  mstream.get('/', (req, res, next) => {
    if (dbManager.getAllUsers().length === 0) {
      return next();
    }

    // Velvet and the bundled Subsonic client both handle auth inside
    // the SPA (Velvet shows an inline form; Refix submits creds via
    // ping/getArtists on first nav). Skip the server-side /login
    // redirect for those — let the SPA decide what to render.
    // TODO: standardize login flow so all UIs handle auth the same way
    if (config.program.ui === 'velvet' || config.program.ui === 'subsonic') {
      return next();
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch (_err) {
      return res.redirect(302, '/login');
    }
  });

  mstream.get('/login', (req, res, next) => {
    // Velvet owns its login UI inside the SPA — a server-side hit on
    // /login is meaningless there, redirect back to the SPA root.
    //
    // Subsonic (Airsonic Refix) ALSO owns its own in-SPA login, BUT
    // operators whose admin session expired need /login to actually
    // serve the default login page so they can get back into /admin
    // (Refix has no admin panel of its own). The default login page
    // is explicitly mounted under ui=subsonic a few lines down; let
    // the request fall through to it rather than bouncing to /.
    if (config.program.ui === 'velvet') {
      return res.redirect(302, '/');
    }

    if (dbManager.getAllUsers().length === 0) {
      return res.redirect(302, '..');
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      return res.redirect(302, '..');
    } catch (_err) {
      next();
    }
  });

  // Server-remote route (must be before static middleware to intercept /server-remote)
  serverPlaybackApi.setupBeforeAuth(mstream);

  // Give access to public folder. Three supported UIs — default, velvet,
  // and the bundled Subsonic web client (Airsonic Refix). Subsonic UI
  // talks to our own /rest/* endpoints so nothing else needs wiring
  // differently.
  const webappDir = config.program.ui === 'velvet'
    ? path.join(config.program.webAppDirectory, 'velvet')
    : config.program.ui === 'subsonic'
      ? path.join(config.program.webAppDirectory, 'subsonic')
      : config.program.webAppDirectory;

  mstream.use('/', express.static(webappDir));

  // ── Universal "core" mounts ────────────────────────────────────────
  //
  // Certain pages MUST render identically regardless of which UI shell
  // is active, because the viewer isn't necessarily the operator. The
  // admin panel must be reachable so an operator can switch UIs; the
  // login page completes the unauthenticated /admin → /login → /admin
  // re-auth round-trip; /shared/:id is viewed by shared-playlist
  // recipients who don't get a say in the host's UI choice.
  //
  // These are mounted AFTER the UI root mount on purpose:
  //
  //   ui='default'   → webapp/ serves the same files at /admin, /login,
  //                    /shared via the root mount; the universal mount
  //                    below is never reached. Zero behavior change.
  //   ui='velvet'    → webapp/velvet/admin/ exists, so the root mount
  //                    serves Velvet's themed admin. Universal mount
  //                    never reached. Velvet keeps its custom admin.
  //   ui='subsonic'  → webapp/subsonic/ has no admin/login/shared
  //                    subtrees, so the root mount calls next() and
  //                    the universal mounts below serve the default
  //                    versions. Fixes the "stuck on Subsonic" bug.
  //
  // /shared-assets and /locales are served UNCONDITIONALLY from
  // webapp/assets/ and webapp/locales/ at stable URLs. The universal
  // HTML pages (webapp/admin/index.html, webapp/login/index.html,
  // webapp/shared/index.html) reference vendor libs via /shared-assets/
  // instead of ../assets/ so their dependencies resolve correctly
  // regardless of which UI happens to own the root. Using absolute
  // /assets/ wouldn't work under ui='subsonic' because Airsonic Refix
  // ships its own webapp/subsonic/assets/ bundle at /assets/.
  mstream.use('/shared-assets', express.static(path.join(config.program.webAppDirectory, 'assets')));
  mstream.use('/locales',       express.static(path.join(config.program.webAppDirectory, 'locales')));
  mstream.use('/admin',         express.static(path.join(config.program.webAppDirectory, 'admin')));
  mstream.use('/login',         express.static(path.join(config.program.webAppDirectory, 'login')));
  mstream.use('/shared',        express.static(path.join(config.program.webAppDirectory, 'shared')));

  // Subsonic-UI SPA fallback: the bundled client is a Vue SPA with
  // history-mode routing (/servers, /albums, /artists, /playlists/...),
  // so a reload of any route other than `/` must serve index.html and
  // let the client-side router take over. Inserted right after the
  // static middleware so it catches unmatched GETs BEFORE the mStream
  // auth wall 401s them — the SPA handles its own auth by calling
  // /rest/ping. Scoped to `ui === 'subsonic'` so the default and
  // velvet UIs keep their 404 behaviour.
  //
  // Explicitly skip API namespaces so those fall through to their
  // real handlers (and 404 properly when the method doesn't exist).
  // `admin`, `login`, `shared`, `shared-assets`, and `locales` are also
  // skipped so the universal core mounts above can serve the default
  // versions instead of the SPA shell.
  if (config.program.ui === 'subsonic') {
    const SPA_SKIP = /^\/(rest|api|media|album-art|server-remote|shared|shared-assets|locales|dlna|admin|login)(\/|$)/;
    const indexPath = path.join(webappDir, 'index.html');
    // Read the shell once at boot — it's ~800B and never changes while
    // the process is up.
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    mstream.get(/.*/, (req, res, next) => {
      if (SPA_SKIP.test(req.path)) { return next(); }
      // Request explicitly asks for a non-HTML resource — let it 404.
      const accept = String(req.get('accept') || '');
      if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
        return next();
      }
      res.type('html').send(indexHtml);
    });
  }

  // Public APIs
  remoteApi.setupBeforeAuth(mstream, server);
  await sharedApi.setupBeforeSecurity(mstream);
  // DLNA routes must be before the auth wall — only needed in same-port mode
  if (config.program.dlna.mode === 'same-port') { dlnaApi.setup(mstream); }

  // Subsonic REST API — sits before the auth wall because it carries its own
  // credentials (u/p query string or apiKey) and populates req.user itself.
  // Only mount when configured for same-port; separate-port uses its own
  // http.Server started in the post-boot hook below.
  if (config.program.subsonic.mode === 'same-port') { subsonicApi.setup(mstream); }

  // Everything below this line requires authentication
  authApi.setup(mstream);

  adminApi.setup(mstream);
  dbApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transcode.setup(mstream);
  scrobblerApi.setup(mstream);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  syncthing.setup();
  federationApi.setup(mstream);
  ytdlApi.setup(mstream);
  albumArtApi.setup(mstream);
  waveformApi.setup(mstream);
  lyricsApi.setup(mstream);
  // V20 housekeeping: clean up 'pending' lyrics_cache rows from any
  // previous process that crashed mid-fetch, and start the periodic
  // orphan sweep. Both are opt-in-cheap (single UPDATE / DELETE on
  // a table that starts empty and is usually tiny).
  lyricsLrclib.onBoot();
  serverPlaybackApi.setup(mstream);
  userApiKeysApi.setup(mstream);

  // VELVET ONLY: additional API modules loaded only when ui='velvet'
  // These provide features specific to the Velvet UI (ListenBrainz, smart playlists,
  // stats tracking, user settings, Discogs, cue points).
  // TODO: evaluate which of these should be promoted to core /v1 APIs
  if (config.program.ui === 'velvet') {
    const [listenbrainzApi, smartPlaylistsApi, wrappedApi,
           userSettingsApi, discogsApi, cuepointsApi, velvetStubs] = await Promise.all([
      import('./api/listenbrainz.js'),
      import('./api/smart-playlists.js'),
      import('./api/wrapped.js'),
      import('./api/user-settings.js'),
      import('./api/discogs.js'),
      import('./api/cuepoints.js'),
      import('./api/velvet-stubs.js'),
    ]);
    listenbrainzApi.setup(mstream);
    smartPlaylistsApi.setup(mstream);
    wrappedApi.setup(mstream);
    userSettingsApi.setup(mstream);
    discogsApi.setup(mstream);
    cuepointsApi.setup(mstream);
    velvetStubs.setup(mstream);
  }

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "server": packageJson.version, "apiVersions": ["1"] }));

  // album art folder
  mstream.get('/album-art/:file', albumArtApi.serveAlbumArtFile);

  // TODO: determine if user has access to the exact file
  // mstream.all('/media/*', (req, res, next) => {
  //   next();
  // });

  // Mount media directories from database libraries
  for (const lib of dbManager.getAllLibraries()) {
    mstream.use(
      '/media/' + lib.name + '/',
      express.static(lib.root_path)
    );
  }

  // error handling
  mstream.use((error, req, res, _next) => {
    winston.error(`Server error on route ${req.originalUrl}`, { stack: error });

    // Check for validation error
    if (error instanceof Joi.ValidationError) {
      return res.status(403).json({ error: error.message });
    }

    if (error instanceof WebError) {
      return res.status(error.status).json({ error: error.message });
    }

    res.status(500).json({ error: 'Server Error' });
  });

  // Start the server!
  server.on('request', mstream);
  server.listen(config.program.port, config.program.address, async () => {
    const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);

    const taskQueue = await import('./db/task-queue.js');
    taskQueue.runAfterBoot();

    if (config.program.dlna.mode !== 'disabled') {
      dlnaSsdp.start();
    }
    if (config.program.dlna.mode === 'separate-port') {
      dlnaServer.start();
    }
    if (config.program.subsonic.mode === 'separate-port') {
      subsonicServer.start();
    }

    // Boot server audio (Rust preferred, CLI fallback) — runs CLI detection
    // eagerly so the admin endpoint has fresh data by the time it's called.
    serverPlaybackApi.bootRustPlayer().catch(() => {});
  });
}

export function reboot() {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();

    if (config.program.federation.enabled === false) {
      syncthing.kill2();
    }

    dlnaSsdp.stop();
    dlnaServer.stop();
    subsonicServer.stop();
    serverPlaybackApi.killRustPlayer();

    // Close the server
    server.close(() => {
      serveIt(config.configFile);
    });
  } catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
