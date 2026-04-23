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
    // Velvet / Subsonic both own their login UI — a server-side hit on
    // /login is meaningless for them, so redirect back to the SPA root.
    if (config.program.ui === 'velvet' || config.program.ui === 'subsonic') {
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
  const velvetDir = path.join(config.program.webAppDirectory, 'velvet');
  const webappDir = config.program.ui === 'velvet'
    ? velvetDir
    : config.program.ui === 'subsonic'
      ? path.join(config.program.webAppDirectory, 'subsonic')
      : config.program.webAppDirectory;

  // Velvet is always reachable at /velvet/ regardless of the selected
  // primary UI, so users on a default-UI install can try Velvet without
  // changing config. The mount sits BEFORE the root static so
  // /velvet/foo.js resolves into webapp/velvet/ cleanly instead of
  // falling through to whatever the root UI happens to expose at
  // /velvet/foo.js. Skipped when the primary UI is already velvet —
  // the root mount covers everything and an extra /velvet mount would
  // just duplicate it.
  if (config.program.ui !== 'velvet') {
    mstream.use('/velvet', express.static(velvetDir));
  }
  mstream.use('/', express.static(webappDir));

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
  if (config.program.ui === 'subsonic') {
    const SPA_SKIP = /^\/(rest|api|media|album-art|server-remote|shared|dlna|velvet)(\/|$)/;
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

  // Velvet-feature API modules. These were originally mounted only when
  // ui='velvet', but the Velvet UI is now available at /velvet/ regardless
  // of the selected primary UI (see the /velvet static mount above), so
  // the backing APIs must always be reachable too. All modules are
  // additive — none override routes a non-velvet UI relies on — so
  // loading them in every mode is cheap and safe.
  const [listenbrainzApi, smartPlaylistsApi, wrappedApi,
         userSettingsApi, discogsApi, cuepointsApi,
         albumsBrowseApi, radioApi, podcastsApi, velvetStubs] = await Promise.all([
    import('./api/listenbrainz.js'),
    import('./api/smart-playlists.js'),
    import('./api/wrapped.js'),
    import('./api/user-settings.js'),
    import('./api/discogs.js'),
    import('./api/cuepoints.js'),
    import('./api/albums-browse.js'),
    import('./api/radio.js'),
    import('./api/podcasts.js'),
    import('./api/velvet-stubs.js'),
  ]);
  listenbrainzApi.setup(mstream);
  smartPlaylistsApi.setup(mstream);
  wrappedApi.setup(mstream);
  userSettingsApi.setup(mstream);
  discogsApi.setup(mstream);
  cuepointsApi.setup(mstream);
  albumsBrowseApi.setup(mstream);
  // radio + podcasts MUST mount before velvet-stubs so their real handlers
  // win route resolution over the fallback stubs that still live there.
  radioApi.setup(mstream);
  podcastsApi.setup(mstream);
  velvetStubs.setup(mstream);

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
    // Tear down the /remote WebSocket server — any open WS client
    // otherwise keeps the HTTP server alive and server.close() below
    // never fires its callback, leaving the user with "server stopped
    // but never rebooted".
    remoteApi.stop();

    // Close the server. server.close() waits for every in-flight HTTP
    // request AND every idle keep-alive socket to drain. The admin
    // client that just issued the UI-switch POST has an open
    // keep-alive socket; without closeAllConnections() we'd wait up
    // to the agent's keep-alive timeout (tens of seconds) before the
    // callback fires. Force the close after a short grace period so
    // in-flight writes get a chance to finish but stragglers don't
    // block the restart.
    server.close(() => {
      serveIt(config.configFile);
    });
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch (_) {}
      }
    }, 1000);
  } catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
