import winston from 'winston';
import express from 'express';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import cookieParser from 'cookie-parser';
import { compression } from './util/compression.js';
import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';

import * as dbApi from './api/db.js';
import * as discoveryApi from './api/discovery.js';
import * as searchApi from './api/search.js';
import * as randomApi from './api/random.js';
import * as playlistApi from './api/playlist.js';
import * as authApi from './api/auth.js';
import * as fileExplorerApi from './api/file-explorer.js';
import * as downloadApi from './api/download.js';
import * as adminApi from './api/admin.js';
import * as irohApi from './api/iroh.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as discoveryDb from './db/discovery-db.js';
import { reapOrphanedScanner } from './db/scan-pidfile.js';
// Federation + syncthing are disabled while the feature is rebuilt
// around the new local-backup story. The source files in
// src/state/syncthing.js and src/api/federation.js stay on disk for
// the eventual revival but aren't wired up — no syncthing process is
// spawned, no /api/v1/federation/* routes are mounted. The admin UI
// shows a "Coming Soon" placeholder where the Federation tab used
// to be.
// import * as syncthing from './state/syncthing.js';
// import * as federationApi from './api/federation.js';
// scanner.js removed — parser now writes directly to SQLite
import * as ytdlApi from './api/ytdl.js';
import * as torrentApi from './api/torrent.js';
import * as dlnaApi from './api/dlna.js';
import * as dlnaSsdp from './dlna/ssdp.js';
import * as dlnaServer from './dlna/dlna-server.js';
import * as subsonicApi from './api/subsonic/index.js';
import * as subsonicServer from './subsonic/subsonic-server.js';
import * as userApiKeysApi from './api/user-api-keys.js';
import * as userSubsonicPasswordApi from './api/user-subsonic-password.js';
import * as serverPlaybackApi from './api/server-playback.js';
import * as albumArtApi from './api/album-art.js';
import * as waveformApi from './api/waveform.js';
import * as scanApi from './api/scan.js';
import * as lyricsApi from './api/lyrics.js';
import * as lyricsLrclib from './api/lyrics-cache.js';
import * as backupApi from './api/backup.js';
import * as backupManager from './backup/manager.js';
// Velvet UI modules — dynamically imported only when ui='velvet' is active
import WebError from './util/web-error.js';
import { isAdminAllowed } from './util/admin-network.js';

import packageJson from '../package.json' with { type: 'json' };

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
  // Size the in-memory live-log ring buffer (admin panel viewer) from config.
  // Independent of writeLogs — the buffer is always active so live logs work
  // even when on-disk logging is off.
  logger.setBufferCapacity(config.program.logBufferSize);
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
  // Response compression for text-ish payloads (API JSON + the static webapp
  // bundle). Operator-configured via config.compression.mode (none | gzip |
  // brotli), default none for now; the middleware reads the mode live so the
  // admin panel can switch it without a reboot. Registered first so it wraps
  // every response. Content-type gated, so audio/* and range/seek streams pass
  // through untouched even when enabled.
  mstream.use(compression);
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
  // Trust Proxy
  if (config.program.trustProxy) {
    mstream.set("trust proxy", true);
  }

  // Reap any scanner orphaned by a previous run (Task Manager kill,
  // taskkill /F, SIGKILL — shutdown paths where neither the kill queue's
  // 'exit' hook nor its signal handlers can run). Must happen BEFORE
  // initDB(): an orphan still writing would lock-fight this boot's
  // migrations, and a migration failure aborts the boot.
  reapOrphanedScanner(config.program.storage.dbDirectory);

  // Setup DB
  dbManager.initDB();

  // The separate music-discovery DB opens at boot only when collection is
  // enabled (the admin toggle initializes it on demand otherwise). Failure
  // here is deliberately non-fatal, unlike initDB(): discovery data is an
  // optional side dataset, and a corrupt discovery.db shouldn't stop the
  // music server from booting.
  if (config.program.scanOptions?.collectDiscoveryData === true) {
    try {
      discoveryDb.initDiscoveryDb();
    } catch (err) {
      winston.error(`discovery DB failed to initialize — discovery data collection disabled this boot: ${err.message}`);
    }
  }

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
    // Application-level IP gate (adminAccess localhost/whitelist modes).
    // trust proxy is configured above (~line 123) so req.ip is correct here;
    // req.user isn't set yet, which is fine — isAdminAllowed only needs req.ip.
    if (!isAdminAllowed(req)) {
      return res.send('<p>Admin Panel is restricted to the local network</p>');
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

  // Gate the entire admin asset tree (index.html, index.js, index.css, …),
  // not just the HTML entry point. Without this, express.static below would
  // hand the admin bundle to IPs blocked by localhost/whitelist mode — the UI
  // would be "restricted" in name only. No JWT here: these are static assets
  // and the network/lockAdmin gate is the real control; the bare /admin
  // handler above keeps the login redirect for the page itself.
  mstream.get('/admin/{*path}', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    if (!isAdminAllowed(req)) {
      return res.send('<p>Admin Panel is restricted to the local network</p>');
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
  const webappDir = config.program.ui === 'velvet'
    ? path.join(config.program.webAppDirectory, 'velvet')
    : config.program.ui === 'subsonic'
      ? path.join(config.program.webAppDirectory, 'subsonic')
      : config.program.webAppDirectory;
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
    const SPA_SKIP = /^\/(rest|api|media|album-art|server-remote|shared|dlna)(\/|$)/;
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
  irohApi.setup(mstream);
  dbApi.setup(mstream);
  discoveryApi.setup(mstream);
  searchApi.setup(mstream);
  randomApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transcode.setup(mstream);
  scrobblerApi.setup(mstream);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  // Federation/syncthing intentionally not set up — see disabled
  // imports near the top of this file.
  // syncthing.setup();
  // federationApi.setup(mstream);
  ytdlApi.setup(mstream);
  torrentApi.setup(mstream);
  albumArtApi.setup(mstream);
  waveformApi.setup(mstream);
  scanApi.setup(mstream);
  lyricsApi.setup(mstream);
  backupApi.setup(mstream);
  // V20 housekeeping: clean up 'pending' lyrics_cache rows from any
  // previous process that crashed mid-fetch, and start the periodic
  // orphan sweep. Both are opt-in-cheap (single UPDATE / DELETE on
  // a table that starts empty and is usually tiny).
  lyricsLrclib.onBoot();
  // V26: mark any 'running' backup_history rows as failed (carryover
  // from a crashed prior process), then start the daily-trigger and
  // trash-retention timers. Idempotent — safe to call on every boot
  // and on reboot().
  backupManager.init();
  serverPlaybackApi.setup(mstream);
  userApiKeysApi.setup(mstream);
  userSubsonicPasswordApi.setup(mstream);

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

  // Versioned APIs. Includes a small `features` block for the frontend
  // to gate UI on without an extra round-trip — currently just whether
  // the Subsonic API surface is mounted (used by the mobile-clients
  // panel to conditionally render the Subsonic password / API key UI).
  // Public — no auth required for this endpoint.
  mstream.get('/api/', (req, res) => res.json({
    server: packageJson.version,
    apiVersions: ["1"],
    features: {
      subsonic: config.program.subsonic.mode !== 'disabled',
    },
  }));

  // album art folder
  mstream.get('/album-art/:file', albumArtApi.serveAlbumArtFile);

  // Mount media directories from database libraries.
  //
  // Dispatch on a `:vpath` route param instead of interpolating each library
  // name into its own route path (`/media/<name>/`). Under Express 5,
  // path-to-regexp throws at registration for names containing characters like
  // ( ) : * +, which would crash the entire boot. That notably bites users
  // upgrading from a pre-v6 (LokiJS) install: their library names were migrated
  // verbatim, without the character restrictions newer libraries get. Routing
  // on a param keeps arbitrary names away from the path parser entirely.
  //
  // Building each handler is guarded too: a library with a missing/invalid
  // root_path is logged and skipped rather than taking down all of /media.
  const mediaHandlers = new Map();
  for (const lib of dbManager.getAllLibraries()) {
    try {
      mediaHandlers.set(lib.name, express.static(lib.root_path));
    } catch (err) {
      winston.error(`Failed to mount media library '${lib.name}' (root: ${lib.root_path}) — it will not be served`, { stack: err });
    }
  }
  // `:vpath` matches a single URL-decoded path segment, so it matches the raw
  // library name stored in the map. express.static confines serving to its own
  // root, so path traversal stays blocked.
  mstream.use('/media/:vpath', (req, res, next) => {
    const handler = mediaHandlers.get(req.params.vpath);
    if (!handler) { return next(); }
    // Authorize against the user's library list — the same vpath check
    // getVPathInfo() applies to file-explorer/download. A user who can't see
    // this library is treated like one requesting an unknown library (fall
    // through to 404) so we don't reveal that it exists. In public mode (no
    // users) req.user.vpaths spans every library, so nothing is restricted.
    if (!req.user || !Array.isArray(req.user.vpaths) || !req.user.vpaths.includes(req.params.vpath)) {
      return next();
    }
    return handler(req, res, next);
  });

  // error handling
  mstream.use((error, req, res, _next) => {
    winston.error(`Server error on route ${req.originalUrl}`, { stack: error });

    // Schema validation failures are malformed-request errors: the client
    // sent a body/params we can't accept. That's 400 Bad Request, not 403
    // Forbidden (which means "authenticated but not permitted").
    if (error instanceof Joi.ValidationError) {
      return res.status(400).json({ error: error.message });
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

    // Torrent completion-watcher (V42-adjacent). Polls the active
    // client periodically; when a managed torrent transitions from
    // downloading → seeding, kicks off a subtree scan so the new
    // files land in the library index without waiting for the next
    // full scan. Cheap no-op when no torrent client is active.
    const completionWatcher = await import('./torrent/completion-watcher.js');
    completionWatcher.start();

    if (config.program.dlna.mode !== 'disabled') {
      dlnaSsdp.start();
    }
    if (config.program.dlna.mode === 'separate-port') {
      dlnaServer.start();
    }
    if (config.program.subsonic.mode === 'separate-port') {
      subsonicServer.start();
    }

    // Iroh P2P remote-access tunnel (opt-in; default off). Lazy-loaded so a
    // platform without a prebuilt @number0/iroh binary still boots — a load or
    // start failure just logs and leaves the feature off. The tunnel proxies to
    // the local HTTP port; it assumes mStream is reachable as plain HTTP there
    // (the QUIC transport already encrypts end-to-end).
    if (config.program.iroh.enabled) {
      try {
        const iroh = await import('./state/iroh.js');
        await iroh.start({
          targetPort: config.program.port,
          secretKey: config.program.iroh.secretKey,
          connectSecret: config.program.iroh.connectSecret,
        });
      } catch (err) {
        winston.error('[iroh] tunnel unavailable on this platform — feature disabled', { stack: err });
      }
    }

    // Discovery-network gossip catalog (opt-in; default off). Start the
    // p2p-sidecar, join the well-known catalog topic with the configured
    // bootstrap peers, and re-announce our current export snapshot if one
    // exists. Detached + non-fatal, mirroring the iroh tunnel above: a host
    // with no sidecar binary just logs and leaves the feature off, and a
    // slow relay handshake must not delay boot.
    if (config.program.discoveryP2p.enabled) {
      (async () => {
        try {
          const p2p = await import('./state/discovery-p2p.js');
          const catalog = await import('./state/discovery-catalog.js');
          catalog.subscribe();
          await p2p.start();
          await p2p.join(config.program.discoveryP2p.bootstrapPeers);
          try {
            const r = await p2p.announceCurrentSnapshot();
            winston.info(`[discovery-p2p] catalog joined; announced snapshot ${r.hash.slice(0, 12)}…`);
          } catch (_err) {
            winston.info('[discovery-p2p] catalog joined; nothing to announce yet (no export snapshot)');
          }
        } catch (err) {
          winston.error(`[discovery-p2p] catalog unavailable — feature disabled this boot: ${err.message}`);
        }
      })();
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

    // Federation/syncthing kill-on-reboot disabled — the syncthing
    // process is never spawned while the feature is rebuilt.
    dlnaSsdp.stop();
    dlnaServer.stop();
    subsonicServer.stop();
    serverPlaybackApi.killRustPlayer();
    // Tear down the /remote WebSocket server — any open WS client
    // otherwise keeps the HTTP server alive and server.close() below
    // never fires its callback, leaving the user with "server stopped
    // but never rebooted".
    remoteApi.stop();

    // Tear down the Iroh tunnel. It binds its own UDP socket independent of the
    // HTTP server, so it doesn't block server.close(); we stop it to free the
    // socket + relay connection. Lazy-imported to match the boot path and to
    // stay a no-op when the native module was never loaded.
    import('./state/iroh.js').then((m) => m.stop()).catch(() => {});

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
