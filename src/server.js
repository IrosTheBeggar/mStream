import winston from 'winston';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
import * as macAppLaunch from './util/mac-app-launch.js';

import packageJson from '../package.json' with { type: 'json' };

let mstream;
let server;
// Live sockets of the CURRENT server, for reboot()'s forced drain. Tracked by
// hand because closeAllConnections() is unusable under Bun: its shim nulls the
// internal handle synchronously inside close(), so any sweep scheduled after
// close() early-returns and does nothing (Node's, by contrast, still destroys
// sockets). Without a working sweep a reboot during an active transfer — a
// transcode, a big download — never fires its close callback and the server
// never comes back. 'connection' fires on both runtimes, so this does.
let liveSockets = new Set();
// Per-boot identity secret for the macOS relaunch probe (see
// src/util/mac-app-launch.js). Published only to loopback callers and mirrored
// into a 0600 file at listen time, so a second .app launch can prove the port
// holder is really our own running instance before redirecting the user's
// browser at it. Regenerated every boot: a stale file can then only fail
// closed.
const instanceNonce = crypto.randomBytes(18).toString('base64url');
const INSTANCE_NONCE_FILE = '.instance-nonce';

function instanceNoncePath() {
  return path.join(config.program.storage.dbDirectory, INSTANCE_NONCE_FILE);
}

// Loopback-only gate for the nonce header. req.socket.remoteAddress is the
// real peer — deliberately NOT req.ip, which honors X-Forwarded-For under
// trustProxy and would let a remote client spoof its way to the nonce.
function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// True from the start of a reboot until its re-served instance is listening.
// Guards against overlapping reboots (two quick admin saves, two admin tabs):
// a second server.close() on an already-closing server still runs its callback,
// which would start a SECOND serveIt racing the first for the port — and the
// loser would exhaust the relisten budget and process.exit() the whole process,
// killing the healthy winner with it.
let rebootInFlight = false;

// `relisten` carries the port THIS process just released, so a reboot's
// re-serve can tell a Windows port-release delay from a real conflict.
// Windows doesn't grant the immediate same-process rebind unix does —
// close()'s callback can fire before the OS frees the port — so retrying
// EADDRINUSE briefly is right THERE, and only there. It is deliberately not a
// boolean: an admin who changed the port is re-serving a port this process
// never owned, where a conflict is permanent, and retrying would spend five
// seconds blaming a transient OS condition before exiting anyway (and on a
// mac .app could even probe a DIFFERENT mStream on the new port and exit 0 as
// "redundant"). First boots never retry for the same reason.
export async function serveIt(configFile, { relisten = null } = {}) {
  mstream = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    // A Finder-launched app has no console to print to — raise a dialog.
    macAppLaunch.announceBootFailure(`mStream could not start — error in the config file:\n${configFile}\n\n${err.message}`);
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
    // Identity headers for the macOS relaunch probe (src/util/mac-app-launch.js),
    // both loopback-only. The probe is a same-machine question, so neither
    // header has any reason to cross the network: on a WAN-exposed instance
    // X-Mstream would turn "is this mStream?" from a heuristic into a
    // one-request positive ID for mass scanners, and the nonce is the secret
    // that proves the port holder is our own server rather than a local
    // impostor. remoteAddress, not req.ip — see isLoopbackRequest.
    if (isLoopbackRequest(req)) {
      res.header('X-Mstream', 'true');
      res.header('X-Mstream-Instance', instanceNonce);
    }
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
  const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
  server.on('request', mstream);
  // Without this handler a failed listen() — port already taken being the
  // canonical case — dies as an uncaught 'error' event: a raw stack in a
  // terminal, and under a Finder launch pure silence. Log it properly; on an
  // app launch the port squatter is usually an earlier mStream instance, in
  // which case this launch is redundant rather than failed (exit 0).
  // Track live sockets for reboot()'s drain (see liveSockets above).
  const mySockets = new Set();
  liveSockets = mySockets;
  server.on('connection', (socket) => {
    mySockets.add(socket);
    socket.on('close', () => mySockets.delete(socket));
  });
  const thisServer = server;
  // Only arm the budget when we are re-taking the SAME port we just released.
  let relistenRetries = (relisten !== null && relisten === config.program.port) ? 20 : 0;   // 20 × 250ms = 5s
  if (relisten !== null && relistenRetries === 0) {
    winston.info(`Reboot moved the port ${relisten} -> ${config.program.port}; a conflict on the new port is real, not a release delay`);
  }
  server.on('error', async (err) => {
    // Only the CURRENT server may act on its errors. A superseded instance
    // (an overlapping reboot's loser) must never run the exit paths below —
    // it would take the healthy live server down with it.
    if (thisServer !== server) {
      winston.warn(`Ignoring '${err.code || err.message}' from a superseded server instance`);
      try { thisServer.close(); } catch (_) { /* already closed */ }
      return;
    }
    if (err.code === 'EADDRINUSE' && relistenRetries > 0) {
      relistenRetries--;
      winston.warn(`Port ${config.program.port} not released yet after reboot — retrying listen (${relistenRetries} left)`);
      // Bare listen(): the 'listening' handler is registered once below —
      // passing a callback here would stack one stale once-listener per
      // failed attempt, all firing together on the eventual success.
      setTimeout(() => { if (thisServer === server) { thisServer.listen(config.program.port, config.program.address); } }, 250);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      winston.error(`Unable to start mStream: port ${config.program.port} is already in use`);
    } else {
      winston.error(`Server error: ${err.message}`, { stack: err });
    }
    // Fatal diagnostics go to fd 2 directly as well: process.exit() below beats
    // winston's File transport, whose boot-time backlog means the on-disk log
    // of a writeLogs install otherwise just stops mid-boot with no reason.
    try { fs.writeSync(2, `mStream fatal: ${err.code === 'EADDRINUSE' ? `port ${config.program.port} already in use` : err.message}\n`); } catch (_) { /* stderr gone too */ }
    // The running instance's nonce, if any — the only proof that the port
    // holder is our own server and not a local impostor.
    let runningNonce;
    try { runningNonce = fs.readFileSync(instanceNoncePath(), 'utf8').trim(); } catch (_) { /* none: probe fails closed */ }
    const alreadyRunning = await macAppLaunch.handleListenError(err, protocol, config.program.port, config.program.address, runningNonce);
    process.exit(alreadyRunning ? 0 : 1);
  });
  const onListening = async () => {
    rebootInFlight = false;   // a reboot's re-serve is complete
    // Publish the instance nonce only once we actually OWN the port — a
    // process that failed to listen must never overwrite the running
    // instance's file, or the relaunch probe would stop recognizing it.
    try {
      fs.writeFileSync(instanceNoncePath(), instanceNonce, { mode: 0o600 });
    } catch (err) {
      winston.warn(`Could not write the instance nonce file: ${err.message}`);
    }
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);
    // Finder launch (macOS .app): surface the UI — nothing else is visible.
    macAppLaunch.announceReady(protocol, config.program.port, config.program.address);

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
  server.once('listening', onListening);
  server.listen(config.program.port, config.program.address);
}

export function reboot() {
  try {
    // Overlapping reboots are a hard outage, not a slow restart: a second
    // close() on an already-closing server still runs its callback, so two
    // serveIt()s race for the port and the loser's exhausted relisten budget
    // exits the process out from under the winner. Two quick admin saves is
    // all it takes. Coalesce instead — the in-flight reboot already re-reads
    // the config from disk, so it picks up both changes.
    if (rebootInFlight) {
      winston.warn('Reboot already in progress — skipping the duplicate request');
      return;
    }
    rebootInFlight = true;
    // Captured BEFORE serveIt's config.setup re-reads the file: the re-serve
    // only gets the EADDRINUSE retry budget if it is re-taking this same port.
    const previousPort = config.program.port;
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();

    dlnaSsdp.stop();
    dlnaServer.stop();
    subsonicServer.stop();
    mdns.stop();
    serverPlaybackApi.killRustPlayer();
    // Tear down the /remote WebSocket server — any open WS client
    // otherwise keeps the HTTP server alive and server.close() below
    // never fires its callback, leaving the user with "server stopped
    // but never rebooted".
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
    // Unlike the teardowns above this one must be SEQUENCED before the
    // re-serve, not fired and forgotten: the stack guards start with a
    // `running` flag it only clears at the END of stop, so a restart landing
    // mid-stop returns early as a no-op and the stop then kills the sidecar it
    // was supposed to replace — leaving the feature dead until a full restart,
    // which is worse than the leak. Bounded by a timeout so a wedged teardown
    // can delay the restart but never block it.
    const p2pStopped = Promise.race([
      import('./state/discovery-p2p-stack.js')
        .then((m) => m.stopDiscoveryP2pStack())
        .catch((err) => winston.warn(`[discovery-p2p] stop during reboot failed: ${err.message}`)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    // Close the server. server.close() waits for every in-flight HTTP
    // request AND every idle keep-alive socket to drain. The admin
    // client that just issued the UI-switch POST has an open
    // keep-alive socket; without closeAllConnections() we'd wait up
    // to the agent's keep-alive timeout (tens of seconds) before the
    // callback fires. Force the close after a short grace period so
    // in-flight writes get a chance to finish but stragglers don't
    // block the restart.
    server.close((err) => {
      // An already-closed server reports ERR_SERVER_NOT_RUNNING here; re-serving
      // on that would mean two live instances fighting for the port.
      if (err) {
        winston.warn(`Reboot: server was already closed (${err.code || err.message}) — not re-serving`);
        rebootInFlight = false;
        return;
      }
      // serveIt can reject before its listen handler exists (bad SSL certs are
      // the classic: config.setup re-reads the file every reboot, so a rotated
      // cert first fails HERE). Unhandled, that's a raw unhandled rejection
      // with the old server already town down — the silent death this PR set
      // out to eliminate, just moved to the reboot path.
      // Gate the re-serve on the discovery-p2p teardown finishing (see above).
      p2pStopped.then(() => serveIt(config.configFile, { relisten: previousPort })).catch((rebootErr) => {
        rebootInFlight = false;
        winston.error('Reboot failed to restart the server', { stack: rebootErr });
        try { fs.writeSync(2, `mStream fatal: reboot failed to restart the server: ${rebootErr.message}\n`); } catch (_) { /* stderr gone */ }
        macAppLaunch.announceBootFailure(`mStream stopped: the server could not restart after a settings change.\n\n${rebootErr.message}`);
        process.exit(1);
      });
    });
    // Force the drain after a grace period. Sweeps the sockets WE tracked
    // rather than calling closeAllConnections(): under Bun that method is a
    // guaranteed no-op once close() has run (its shim nulls the internal
    // handle synchronously inside close()), so an active transfer would hold
    // the close callback — and therefore the whole restart — open forever.
    // Destroying the old server's sockets is safe for the new one: `mySockets`
    // is per-instance, and serveIt rebinds `liveSockets` to the new set.
    const closingSockets = liveSockets;
    setTimeout(() => {
      for (const socket of closingSockets) {
        try { socket.destroy(); } catch (_) { /* already gone */ }
      }
      closingSockets.clear();
    }, 1000);
  } catch (err) {
    rebootInFlight = false;
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
