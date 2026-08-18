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
import crypto from 'crypto';
import { dataRoot, usingFallbackDataRoot } from './util/esm-helpers.js';

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
import * as discoveryP2pApi from './api/discovery-p2p.js';
import * as discoveryFederationApi from './api/discovery-federation.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as discoveryDb from './db/discovery-db.js';
import { reapOrphanedScanner } from './db/scan-pidfile.js';
// scanner.js removed — parser now writes directly to SQLite
import * as federationApi from './api/federation.js';
import * as federationDiscoveryApi from './api/federation-discovery.js';
import * as federationLimitsApi from './api/federation-limits.js';
import * as federationStreamApi from './api/federation-stream.js';
import * as ytdlApi from './api/ytdl.js';
import * as torrentApi from './api/torrent.js';
import * as dlnaApi from './api/dlna.js';
import * as dlnaSsdp from './dlna/ssdp.js';
import * as dlnaServer from './dlna/dlna-server.js';
import * as mdns from './discovery/mdns.js';
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
// Live sockets of the CURRENT listener, for reboot()'s forced drain. Tracked by
// hand because closeAllConnections() is unusable under Bun: its shim nulls the
// internal handle synchronously inside close(), so any sweep scheduled after
// close() early-returns and does nothing (Node's, by contrast, still destroys
// sockets). Without a working sweep a reboot during an active transfer — a
// transcode, a big download — never fires its close callback and the server
// never comes back. 'connection' fires on both runtimes, so this does. The set
// lives as long as the listening socket does (it is NOT per serveIt(): a
// same-bind reboot keeps the socket and swaps only the app — see below).
let liveSockets = new Set();
// Identity of the CURRENT listener: { port, address, ssl, fingerprint }. Set
// once a listen succeeds; reboot() hands it to the re-serve as `relisten` so
// serveIt() can tell "same socket, keep it" from "bind changed, recycle it".
let currentBind = null;
// True from the start of a reboot until its re-served instance is serving.
// Guards against overlapping reboots (two quick admin saves, two admin tabs):
// two serveIt()s racing for the same port would have the loser exhaust its
// relisten budget and process.exit() the whole process, killing the healthy
// winner with it.
let rebootInFlight = false;

// Placeholder request handler for the reboot window: the listening socket stays
// bound while the app is torn down and rebuilt, and callers get an honest 503
// instead of a connection refused (or, worse, a hang — see keepListener below).
function rebootStub(req, res) {
  res.statusCode = 503;
  res.setHeader('Retry-After', '1');
  res.setHeader('Connection', 'close');
  res.end('mStream is restarting');
}

function bindLabel(bind) {
  const host = bind.address.includes(':') ? `[${bind.address}]` : bind.address;
  return `${bind.ssl ? 'https' : 'http'}://${host}:${bind.port}`;
}

function sameBind(a, b) {
  return a.port === b.port && a.address === b.address && a.ssl === b.ssl && a.fingerprint === b.fingerprint;
}

// Why a same-bind reboot keeps the listening socket instead of close()+listen():
// on Windows, a listen socket is a kernel object shared with every child that
// inherited a handle to it, and under Bun <= 1.3.14 EVERY spawned child does
// (uSockets created inheritable handles; fixed upstream in oven-sh/bun#36938,
// unreleased as of Aug 2026). So close() in the parent releases nothing while a
// scanner, transcode, ffmpeg download or enrichment worker is alive — the port
// stays LISTENING (and even completes TCP handshakes that then hang) until the
// last such child exits, which for a scan or a backfill can be an hour. A
// close()+listen() reboot therefore meant EADDRINUSE for the child's lifetime;
// with the old 5 s budget it meant the whole process exiting after any admin
// save made mid-scan. Never giving the socket up sidesteps all of it, on every
// runtime: only a changed bind (port, address, http<->https, rotated cert
// material) recycles the listener.
//
// `relisten` carries the bind THIS process is currently serving, so a reboot's
// re-serve can (a) keep the socket when nothing about the bind changed and
// (b) when it did change but the PORT is the same, tell a release delay from a
// real conflict. Windows doesn't grant the immediate same-process rebind unix
// does — close()'s callback can fire before the OS frees the port — and the
// inherited-handle hold above is the same symptom lasting longer, so retrying
// EADDRINUSE is right THERE, and only there. It is deliberately not a boolean:
// an admin who changed the port is re-serving a port this process never owned,
// where a conflict is permanent, and retrying would only delay the inevitable
// exit while blaming a transient OS condition. First boots never retry for the
// same reason.
export async function serveIt(configFile, { relisten = null } = {}) {
  mstream = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    // A permission/read-only failure is NOT a malformed config, and saying so
    // sends the user hunting through a file that is usually fine (or absent):
    // name the real cause instead. dataRoot already redirects writable state
    // away from a read-only app (util/esm-helpers.js), so reaching this means
    // the chosen location itself is unwritable — an explicit -j/MSTREAM_CONFIG
    // pointing somewhere read-only, or a container mount without permission.
    // (Desktop-launch users see the launcher's own boot-failure dialog; this
    // message is what its server log carries.)
    const denied = err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM';
    winston.error(denied
      ? `mStream could not start — it can't write to ${configFile}: the location is read-only or permission was denied (${err.message})`
      : 'Failed to validate config file', { stack: err });
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
  // Say so when the app couldn't be written to and state went elsewhere —
  // otherwise "where is my database?" has no answer anywhere in the logs.
  if (usingFallbackDataRoot) {
    winston.info(`App directory is read-only — storing config, database and caches in ${dataRoot}`);
  }

  // Set server
  const wantSsl = !!(config.program.ssl && config.program.ssl.cert && config.program.ssl.key);
  let sslMaterial = null;
  if (wantSsl) {
    try {
      sslMaterial = {
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert),
      };
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  }
  config.setIsHttps(wantSsl);
  const bind = {
    port: config.program.port,
    address: config.program.address,
    ssl: wantSsl,
    // Identity is the cert MATERIAL, not the file names: a rotated cert under
    // unchanged paths must still recycle the listener, or the reused socket
    // would keep serving the old certificate.
    fingerprint: wantSsl
      ? crypto.createHash('sha256').update(sslMaterial.key).update(sslMaterial.cert).digest('hex')
      : null,
  };
  // Keep the socket when a reboot re-serves the very same bind (the common
  // case: trust proxy, UI switch, request-size limit...). See keepListener's
  // rationale above serveIt.
  const keepListener = relisten !== null && !!server && server.listening && sameBind(relisten, bind);
  if (!keepListener) {
    // Build the replacement first: an unreadable or malformed cert must fail
    // here, before anything is torn down.
    let next;
    try {
      next = wantSsl ? https.createServer(sslMaterial) : http.createServer();
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
    if (relisten !== null && server && server.listening) {
      // The bind changed: this is a real recycle. Release the old listener
      // before the new one binds, so a same-port move (address or TLS
      // change) doesn't compete with itself. Node's close() waits for the
      // remaining connections; reboot()'s grace-period sweep (already armed)
      // destroys the stragglers so this settles within ~1 s. Under Bun the
      // callback fires synchronously.
      winston.info(`Reboot: bind changed ${bindLabel(relisten)} -> ${bindLabel(bind)}; recycling the listener`);
      const oldSockets = liveSockets;
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) { winston.warn(`Reboot: closing the previous listener reported ${err.code || err.message}`); }
          resolve();
        });
        // The socket kept accepting (and answering 503) during the teardown,
        // so connections younger than reboot()'s snapshot exist; a stalled one
        // must not hold close() — and this reboot — open indefinitely.
        setTimeout(() => {
          for (const socket of oldSockets) {
            try { socket.destroy(); } catch (_) { /* already gone */ }
          }
        }, 1000);
      });
    }
    server = next;
    // Track live sockets for reboot()'s drain (see liveSockets above). Bound
    // to the socket's lifetime, so registered exactly once per listener.
    const mySockets = new Set();
    liveSockets = mySockets;
    server.on('connection', (socket) => {
      mySockets.add(socket);
      socket.on('close', () => mySockets.delete(socket));
    });
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

    let decoded;
    try {
      decoded = jwt.verify(req.cookies['x-access-token'], config.program.secret);
    } catch (_err) {
      return res.redirect(302, '/login');
    }

    // A valid token is NOT enough — verify the ROLE too. Every /api/v1/admin/*
    // call the panel makes is gated on req.user.admin, so serving the panel to
    // a non-admin handed them a shell in which every request fails. Send them
    // to the player instead; bouncing to /login would be wrong (their session
    // is fine) and would loop, since logging back in returns the same user.
    const user = decoded.username ? dbManager.getUserByUsername(decoded.username) : null;
    if (!user) { return res.redirect(302, '/login'); }
    if (user.is_admin !== 1) {
      winston.warn(`Non-admin user '${decoded.username}' from ${req.ip} requested the admin panel`);
      return res.redirect(302, '/');
    }

    next();
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

  // Bandwidth caps for federated readers — must sit right after the wall
  // (needs req.user.federation) and before every route/static mount whose
  // responses it meters.
  federationLimitsApi.setup(mstream);

  adminApi.setup(mstream);
  irohApi.setup(mstream);
  discoveryApi.setup(mstream);
  discoveryP2pApi.setup(mstream);
  discoveryFederationApi.setup(mstream);
  dbApi.setup(mstream);
  searchApi.setup(mstream);
  randomApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transcode.setup(mstream);
  scrobblerApi.setup(mstream);
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  federationApi.setup(mstream);
  federationDiscoveryApi.setup(mstream);
  federationStreamApi.setup(mstream);
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
  const protocol = bind.ssl ? 'https' : 'http';
  const onListening = async () => {
    currentBind = bind;
    rebootInFlight = false;   // a reboot's re-serve is complete
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

    // Federation endpoint (opt-in; default off) — the third iroh persona,
    // independent of the tunnel above and the discovery sidecar below. Same
    // lazy-load contract: a platform without the native binary just logs and
    // leaves the feature off.
    if (config.program.federation.enabled) {
      try {
        const federation = await import('./state/federation.js');
        await federation.start({
          targetPort: config.program.port,
          secretKey: config.program.federation.secretKey,
        });
      } catch (err) {
        winston.error('[federation] endpoint unavailable on this platform — feature disabled', { stack: err });
      }
    }

    // Discovery-network gossip catalog (opt-in; default off, and also
    // toggleable at runtime through the admin Discovery page — both paths
    // run the SAME stack in state/discovery-p2p-stack.js). Detached +
    // non-fatal, mirroring the iroh tunnel above: a host with no sidecar
    // binary just logs and leaves the feature off, and a slow relay
    // handshake must not delay boot.
    if (config.program.discoveryP2p.enabled) {
      (async () => {
        try {
          const stack = await import('./state/discovery-p2p-stack.js');
          await stack.startDiscoveryP2pStack();
        } catch (err) {
          winston.error(`[discovery-p2p] catalog unavailable — feature disabled this boot: ${err.message}`);
        }
      })();
    }

    // Advertise the API over mDNS/DNS-SD so LAN clients (the portable player)
    // discover us without an IP. Advertise-only; safe to start unconditionally
    // (it self-disables via config and never throws on the boot path).
    if (config.program.discovery.mdns.enabled) {
      mdns.start();
    }

    // Boot server audio (Rust preferred, CLI fallback) — runs CLI detection
    // eagerly so the admin endpoint has fresh data by the time it's called.
    serverPlaybackApi.bootRustPlayer().catch(() => {});
  };

  if (keepListener) {
    // Same bind: the socket never stopped listening. Swap the rebuilt app in
    // for the reboot stub — atomically, in one tick, so no request falls into
    // a gap — and run the post-listen boot chores exactly as a fresh listen
    // would. The 'error' and 'connection' listeners registered when this
    // socket was created stay in place; nothing about them is per-app.
    winston.info(`Reboot: bind unchanged (${bindLabel(bind)}) — keeping the listening socket`);
    server.off('request', rebootStub);
    server.on('request', mstream);
    // Fire-and-forget on purpose: same contract as the 'listening' event
    // dispatch below (a rejection surfaces the same way in both paths).
    onListening();
    return;
  }

  server.on('request', mstream);
  const thisServer = server;
  // Without this handler a failed listen() — port already taken being the
  // canonical case — dies as an uncaught 'error' event: a raw stack in a
  // terminal, and under a desktop launch pure silence. Log it properly and
  // exit non-zero; under the launcher, supervision reports the exit and the
  // reason lands in server-console.log.
  //
  // EXCEPT when we are re-taking the very port this process was serving a
  // moment ago (a reboot that changed the address or TLS setup but not the
  // port). There EADDRINUSE is a release delay, not a conflict — Windows can
  // report the port busy for a moment after close(), and under Bun <= 1.3.14
  // on Windows a live child that inherited the old listen socket holds it
  // until that child exits (see keepListener above). Both end on their own;
  // neither is a reason to take the process down. So retry with backoff for
  // as long as it takes, say why, and let the eventual listen succeed.
  const samePortRelisten = relisten !== null && relisten.port === bind.port;
  if (relisten !== null && !samePortRelisten) {
    winston.info(`Reboot moved the port ${relisten.port} -> ${bind.port}; a conflict on the new port is real, not a release delay`);
  }
  const relistenStartedAt = Date.now();
  let relistenAttempts = 0;
  let relistenLastLoggedAt = 0;
  let relistenDiagnosed = false;
  server.on('error', (err) => {
    // Only the CURRENT server may act on its errors. A superseded instance
    // (an overlapping reboot's loser) must never run the exit paths below —
    // it would take the healthy live server down with it.
    if (thisServer !== server) {
      winston.warn(`Ignoring '${err.code || err.message}' from a superseded server instance`);
      try { thisServer.close(); } catch (_) { /* already closed */ }
      return;
    }
    if (err.code === 'EADDRINUSE' && samePortRelisten) {
      relistenAttempts++;
      const waitedMs = Date.now() - relistenStartedAt;
      // 250 ms for the first two seconds (the ordinary Windows release delay),
      // then 1 s, then every 5 s once it is clearly a held socket.
      const delay = waitedMs < 2000 ? 250 : waitedMs < 30000 ? 1000 : 5000;
      // One line at once, the diagnosis once it has clearly outlasted a
      // release delay (~5 s), then a heartbeat every 30 s.
      if (relistenAttempts === 1) {
        winston.warn(`Port ${bind.port} not released yet after reboot — retrying listen`);
        relistenLastLoggedAt = Date.now();
      } else if (waitedMs >= 5000 && Date.now() - relistenLastLoggedAt >= (relistenDiagnosed ? 30000 : 0)) {
        winston.warn(
          `Port ${bind.port} still held ${Math.round(waitedMs / 1000)}s after reboot — retrying until it frees ` +
          '(mStream is unreachable meanwhile). A child process that was alive during the reboot — a scan, ' +
          'transcode, ffmpeg download or enrichment worker — can hold the old listening socket until it ' +
          'exits: under Bun <= 1.3.14 on Windows spawned children inherit it (oven-sh/bun#36936).');
        relistenDiagnosed = true;
        relistenLastLoggedAt = Date.now();
      }
      // Bare listen(): the 'listening' handler is registered once below —
      // passing a callback here would stack one stale once-listener per
      // failed attempt, all firing together on the eventual success.
      setTimeout(() => { if (thisServer === server) { thisServer.listen(bind.port, bind.address); } }, delay);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      winston.error(`Unable to start mStream: port ${bind.port} is already in use`);
    } else {
      winston.error(`Server error: ${err.message}`, { stack: err });
    }
    // Fatal diagnostics go to fd 2 directly as well: process.exit() below beats
    // winston's File transport, whose boot-time backlog means the on-disk log
    // of a writeLogs install otherwise just stops mid-boot with no reason.
    try { fs.writeSync(2, `mStream fatal: ${err.code === 'EADDRINUSE' ? `port ${bind.port} already in use` : err.message}\n`); } catch (_) { /* stderr gone too */ }
    process.exit(1);
  });
  server.once('listening', () => {
    if (relistenAttempts > 0) {
      winston.info(`Port ${bind.port} released after ${Math.round((Date.now() - relistenStartedAt) / 1000)}s (${relistenAttempts} retries)`);
    }
    onListening();
  });
  server.listen(bind.port, bind.address);
}

export function reboot() {
  try {
    // Overlapping reboots are a hard outage, not a slow restart: two
    // serveIt()s would both try to take over the listener (or race for the
    // port on a bind change, where the loser exits the process out from under
    // the winner). Two quick admin saves is all it takes. Coalesce instead —
    // the in-flight reboot already re-reads the config from disk, so it picks
    // up both changes.
    if (rebootInFlight) {
      winston.warn('Reboot already in progress — skipping the duplicate request');
      return;
    }
    rebootInFlight = true;
    // The bind we are serving right now, captured BEFORE serveIt's
    // config.setup re-reads the file: the re-serve keeps the socket if the
    // new config binds identically, and only gets the EADDRINUSE patience if
    // it is at least re-taking this same port.
    const previousBind = currentBind;
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();

    dlnaSsdp.stop();
    dlnaServer.stop();
    subsonicServer.stop();
    mdns.stop();
    serverPlaybackApi.killRustPlayer();
    // Tear down the /remote WebSocket server: it detaches its upgrade/error
    // listeners from the HTTP server (serveIt attaches a fresh one) and closes
    // its clients — an open WS client would otherwise keep a recycled listener
    // from ever closing, leaving the user with "server stopped but never
    // rebooted".
    remoteApi.stop();
    // Pause the backup scheduler's timers (intervals + one-shot boot
    // ticks). serveIt below re-runs backupManager.init(), which re-arms
    // them — without this, each reboot left the old boot timeouts
    // pending alongside the new ones.
    backupManager.shutdown();

    // Tear down the Iroh tunnel. It binds its own UDP socket independent of the
    // HTTP server, so it doesn't block server.close(); we stop it to free the
    // socket + relay connection. Lazy-imported to match the boot path and to
    // stay a no-op when the native module was never loaded.
    import('./state/iroh.js').then((m) => m.stop()).catch(() => {});
    // Same for the federation endpoint — its own UDP socket + relay conn.
    // Peer bridges (loopback servers + outbound conns) go down with it.
    import('./state/federation-client.js').then((m) => m.stopAll()).catch(() => {});
    import('./state/federation.js').then((m) => m.stop()).catch(() => {});
    // Same for the discovery-network gossip stack: sidecar process, gossip
    // subscription, mesh-health watch, auto-fetch and pruning timers. Without
    // it, an operator who DISABLES the feature in the config file and uses the
    // admin reboot (the documented flow) keeps publishing snapshots and
    // gossiping their catalog until a full process restart, while the server
    // reports the feature off.
    //
    // Unlike the teardowns above this one is SEQUENCED before the re-serve
    // rather than fired and forgotten, so a reboot that disables the feature
    // has actually released the sidecar before the new instance boots.
    //
    // The timeout is a LATENCY bound, not the correctness mechanism: a wedged
    // teardown can delay the restart but never block it. Correctness lives in
    // the stack itself, which now clears `running` up front and makes a start
    // wait on the in-flight stop (see startDiscoveryP2pStack). That ordering
    // matters because a full stop can outlast this timeout — the sidecar gets
    // a shutdown-RPC grace AND a SIGKILL fallback — and when it does, the
    // restart lands mid-stop. Before the stack serialized, that combination
    // silently left the feature dead: the restart no-oped on a stale flag and
    // the late stop killed the sidecar it was meant to replace.
    const p2pStopped = Promise.race([
      import('./state/discovery-p2p-stack.js')
        .then((m) => m.stopDiscoveryP2pStack())
        .catch((err) => winston.warn(`[discovery-p2p] stop during reboot failed: ${err.message}`)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    // Park the listener rather than closing it: the socket stays bound and
    // answers 503 while the app is rebuilt, and serveIt() either swaps the
    // new app in (same bind — the usual case) or recycles the socket itself
    // (bind changed). See keepListener above serveIt for why the socket must
    // not be given up here.
    if (server) {
      server.off('request', mstream);
      server.on('request', rebootStub);
    }
    // Drop the connections that existed at reboot time after a short grace
    // period, so in-flight writes get a chance to finish but a long transfer
    // (a transcode, a big download) doesn't keep the old app's handlers alive
    // indefinitely — and, on a bind change, so Node's close() can settle (it
    // waits for every connection to drain, and closeAllConnections() is a
    // guaranteed no-op under Bun once close() has run). Snapshot, not the
    // live set: connections the kept socket accepts after this moment belong
    // to the stub and then to the new app.
    const closingSockets = [...liveSockets];
    setTimeout(() => {
      for (const socket of closingSockets) {
        try { socket.destroy(); } catch (_) { /* already gone */ }
      }
    }, 1000);
    // serveIt can reject before its listen handler exists (bad SSL certs are
    // the classic: config.setup re-reads the file every reboot, so a rotated
    // cert first fails HERE). Unhandled, that's a raw unhandled rejection
    // with the old app already torn down — the silent death #803 set out to
    // eliminate, just moved to the reboot path.
    // Gate the re-serve on the discovery-p2p teardown finishing (see above).
    p2pStopped.then(() => serveIt(config.configFile, { relisten: previousBind })).catch((rebootErr) => {
      rebootInFlight = false;
      winston.error('Reboot failed to restart the server', { stack: rebootErr });
      try { fs.writeSync(2, `mStream fatal: reboot failed to restart the server: ${rebootErr.message}\n`); } catch (_) { /* stderr gone */ }
      process.exit(1);
    });
  } catch (err) {
    rebootInFlight = false;
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
