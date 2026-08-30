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
import net from 'net';
import crypto from 'crypto';
import { dataRoot, usingFallbackDataRoot } from './util/esm-helpers.js';
import { installedPlayerPath, playerLoadableHere } from './util/mstream-player-bootstrap.js';

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
import * as sim from './db/discovery-similarity.js';
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
import { classifyError } from './util/web-error.js';
import { isAdminAllowed } from './util/admin-network.js';
import { writeJsonAtomic, completedWrites } from './util/atomic-json.js';
import * as adminUtil from './util/admin.js';
import * as updateCheck from './util/update-check.js';
import * as bootWatchdog from './util/boot-watchdog.js';

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
// A reboot request that arrived while one was in flight. The in-flight reboot
// re-reads the config from disk, but only ONCE, at its start: a save that
// lands after that read (two admin tabs, a slow-bodied POST already dispatched
// to the old app) would otherwise be on disk and never applied — the admin
// sees "Updated" while the server runs the previous value until the next
// restart. So a coalesced request re-runs the reboot once the in-flight one
// has re-served — but only if a config write actually completed after that
// read (configWritesAtRead vs util/atomic-json's completed-write count);
// otherwise the in-flight reboot already applied it and a second bounce would
// just cost another tunnel/listener cycle.
let rebootPending = false;
let configWritesAtRead = 0;
// Set by onListening's lazy import; update-check's idle test reads it (null
// = "not fully booted yet", which idle() treats as busy — auto-apply never
// fires into a half-started server).
let taskQueueMod = null;
// When a request last touched this server (the auto-update idle gate's
// quiet-window clock — see the middleware that maintains it). Module scope
// on purpose: a soft reboot() must not reset a user's recency to zero.
let lastUserRequestAt = Date.now();
// Bumped by every reboot(); each request tags its socket with the generation
// serving it, so reboot()'s grace-period sweep can tell "still busy with an
// OLD-app response" (destroy: that handler must not live on) from "idle
// keep-alive" or "already carrying a NEW-app response" (leave alone: the kept
// socket swapped apps ~70 ms in, and destroying those cut audio streams the
// new app was mid-way through).
let appGeneration = 0;

// Per-request socket tagging for the sweep above. Registered ONCE per
// listener alongside the 'connection' tracker; runtimes/servers where
// req.socket is not the accepted socket (Bun's shim, https' TLSSocket over
// the raw 'connection' socket) simply leave sockets untagged, and untagged
// sockets get the pre-existing behaviour (destroyed by the sweep).
function tagRequestSocket(req, res) {
  const socket = req.socket;
  if (!socket) { return; }
  socket._mstreamGen = appGeneration;
  socket._mstreamBusy = true;
  res.once('close', () => { socket._mstreamBusy = false; });
}

// Placeholder request handler for the reboot window: the listening socket stays
// bound while the app is torn down and rebuilt, and callers get an honest 503
// instead of a connection refused (or, worse, a hang — see keepListener below).
function rebootStub(req, res) {
  res.statusCode = 503;
  res.setHeader('Retry-After', '1');
  res.setHeader('Connection', 'close');
  res.end('mStream is restarting');
}

// Put a rejected bind change back: the previous port/address into the config
// file (atomically — the admin's own saves go through the same writer), so
// the next start doesn't fail on the value this one just refused.
async function revertBindInConfig(configFile, prev) {
  const doc = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
  doc.port = prev.port;
  doc.address = prev.address;
  await writeJsonAtomic(configFile, doc);
}

// Can this machine bind {port, address} right now? A throwaway net.Server —
// node:net, deliberately: Bun's node:http server reports an address that
// isn't local as EADDRINUSE ("Is port N in use?"), which the same-port relisten
// patience would then wait on forever, while its node:net server says
// EADDRNOTAVAIL like Node does. Port 0 probes the ADDRESS alone.
function probeBind(port, address) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const timer = setTimeout(() => { try { probe.close(); } catch (_) { /* never opened */ } resolve({ ok: false, code: 'ETIMEDOUT' }); }, 3000);
    probe.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: err.code || err.message }); });
    probe.listen(port, address, () => { clearTimeout(timer); probe.close(() => resolve({ ok: true })); });
  });
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
    // Captured BEFORE the read: any admin save that completes from here on
    // may have missed this read (see rebootPending).
    configWritesAtRead = completedWrites(configFile);
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
    // EJSONPARSE (util/atomic-json.js readJsonFile): the config file itself
    // is broken JSON — say so with the path, don't bury it under the generic
    // validate line (a hand-edited config on Windows is the common case).
    winston.error(denied
      ? `mStream could not start — it can't write to ${configFile}: the location is read-only or permission was denied (${err.message})`
      : err.code === 'EJSONPARSE'
        ? `mStream could not start — config file ${err.message}`
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
  let keepListener = relisten !== null && !!server && server.listening && sameBind(relisten, bind);
  if (!keepListener && relisten !== null && server && server.listening &&
      (relisten.port !== bind.port || relisten.address !== bind.address)) {
    // The admin moved the port/address. Before giving up a socket that works,
    // prove the new one is servable AT ALL — an address that isn't this
    // machine's, a privileged/reserved port, a port another program owns. It
    // used to be: recycle, fail to listen, exit — and exit again on every
    // later start, the bad value now being on disk. Now: refuse the change,
    // put the previous port/address back in the config, keep serving on the
    // socket we have. A port move probes the exact new bind (that port is one
    // this process never held, so "in use" is real); an address move on the
    // same port probes the address alone (port 0) — the exact bind would fail
    // against our own still-open socket on Linux.
    const portMoved = relisten.port !== bind.port;
    const probe = await probeBind(portMoved ? bind.port : 0, bind.address);
    if (!probe.ok) {
      const rejected = bindLabel(bind);
      bind.port = relisten.port;
      bind.address = relisten.address;
      config.program.port = relisten.port;
      config.program.address = relisten.address;
      winston.error(`The new bind ${rejected} cannot be served (${probe.code}) — keeping ${bindLabel(bind)} and restoring port/address in the config file`);
      try { fs.writeSync(2, `mStream: bind ${rejected} rejected (${probe.code}); staying on ${bindLabel(bind)}\n`); } catch (_) { /* stderr gone */ }
      revertBindInConfig(configFile, relisten).catch((revertErr) => {
        winston.error(`Could not restore the previous port/address in ${configFile}: ${revertErr.message} — edit it by hand or the next start will fail the same way`);
      });
      // Nothing about the bind changes now (unless TLS did too, which still
      // recycles — onto the address we know works).
      keepListener = sameBind(relisten, bind);
    }
  }
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
    server.on('request', tagRequestSocket);
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
  // Activity clock for auto-update's idle gate (update-check.js): an auto
  // restart must wait out a QUIET window, not just "no bytes in flight" —
  // an actively browsing user has no in-flight response at most instants.
  // Every request refreshes the clock EXCEPT the admin card's own
  // update-status poll (GET /api/v1/admin/update, every 5s while the About
  // page is open): the surface that DISPLAYS an update must never be the
  // reason it cannot apply. An idle player tab makes no periodic requests
  // (the jukebox and server-audio polls only run while those modes are in
  // use — which genuinely is activity), so an open-but-abandoned tab goes
  // quiet on its own.
  mstream.use((req, res, next) => {
    if (!(req.method === 'GET' && req.path === '/api/v1/admin/update')) {
      lastUserRequestAt = Date.now();
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

  // Backfill the one-time onboarding marker for installs that predate it:
  // any library or any user means this server was set up long ago, and the
  // flag's absence must not greet an upgrader (or a config restored beside
  // an existing database) with first-run behavior. Best-effort — a
  // read-only config just means the boot log re-invites, which is noise,
  // not damage.
  if (!config.program.setupComplete
      && (dbManager.getAllLibraries().length > 0 || dbManager.getAllUsers().length > 0)) {
    // Awaited on purpose: the launcher reads the flag from the config file
    // when its health probe reports the server up, and an upgrader's very
    // first boot of a flag-aware build must have the backfill ON DISK
    // before listen — a fire-and-forget write raced that read, and losing
    // it would greet a years-old install with the first-run wizard.
    try {
      await adminUtil.markSetupComplete();
    } catch (err) {
      winston.warn(`could not backfill setupComplete: ${err.message}`);
    }
  }

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
  updateCheck.setup(mstream, {
    // Idle = safe to restart into a staged update: no socket carrying an
    // in-flight response (the same tagging reboot()'s drain sweep uses),
    // no scan running, AND a quiet window since the last user request (the
    // activity-clock middleware above) — in-flight alone misses an actively
    // browsing user, who has no response in flight at most instants.
    // Conservative before boot completes.
    hasBusySockets: () => {
      for (const s of liveSockets) { if (s._mstreamBusy) { return true; } }
      return false;
    },
    isScanning: () => (taskQueueMod ? taskQueueMod.isScanning() : true),
    msSinceActivity: () => Date.now() - lastUserRequestAt,
  });
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
      // Whether a sonic-similarity query would find anything RIGHT NOW.
      // Distinct from the ping's `discovery` flag, which says the feature is
      // switched on: a server can have it on with an unfinished scan, and
      // that combination is exactly what makes clients look broken. Auto DJ
      // sends similarTo/minSimilarity, every pick 400s on the empty pool, and
      // the queue silently stops advancing.
      //
      // A boolean, not a count: this endpoint is public, and how many tracks
      // are analysed is library-size information. Clients only need to know
      // whether to offer the feature.
      discoveryReady: sim.hasEmbeddings(),
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

  // Error handling — the terminal translator from thrown errors to HTTP
  // responses, and the last place log severity gets decided (the policy
  // itself is classifyError in util/web-error.js, unit-pinned). Handled
  // rejections log as rejections at warn with ip + user-agent, so a
  // misbehaving client names itself in the log line (attributing the /ping
  // one took router logs; never again). Error level + a stack are reserved
  // for what they imply: genuine server failures.
  mstream.use((error, req, res, _next) => {
    const from = `${req.ip} ${String(req.headers['user-agent'] || '-').slice(0, 80)}`;

    // Schema validation failures are malformed-request errors: the client
    // sent a body/params we can't accept. That's 400 Bad Request, not 403
    // Forbidden (which means "authenticated but not permitted").
    if (error instanceof Joi.ValidationError) {
      winston.warn(`Rejected ${req.method} ${req.originalUrl} (${from}) — 400: ${error.message}`);
      return res.status(400).json({ error: error.message });
    }

    const c = classifyError(error);
    if (c.kind === 'web') {
      if (c.level === 'error') {
        winston.error(`Request failed: ${req.method} ${req.originalUrl} (${from}) — ${c.status}: ${error.message}`);
      } else {
        winston.warn(`Rejected ${req.method} ${req.originalUrl} (${from}) — ${c.status}: ${error.message}`);
      }
      return res.status(c.status).json({ error: error.message });
    }

    // Unchanged wording + stack metadata on purpose: this line now MEANS
    // something again — anyone grepping for it finds only real crashes.
    winston.error(`Server error on route ${req.originalUrl}`, { stack: error });
    res.status(500).json({ error: 'Server Error' });
  });

  // Start the server!
  const protocol = bind.ssl ? 'https' : 'http';
  const onListening = async () => {
    currentBind = bind;
    rebootInFlight = false;   // a reboot's re-serve is complete
    // A successful listen acknowledges this boot: the headless boot
    // watchdog's attempt counter (armed pre-boot in cli-boot-wrapper.js)
    // starts over. Cheap no-op everywhere the guard never ran.
    bootWatchdog.markBootOk();
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);

    // First-boot invitation, keyed to the one-time setupComplete marker
    // (util/admin.js markSetupComplete — written at the first library or
    // first user, backfilled above for installs that predate the flag).
    // The terminal-wizard line appears only when the
    // player binary is already on this machine (bundles ship it; musl and
    // docker hosts have no build and get the browser line alone) AND its
    // libraries load here (headless linux without ALSA can't even run its
    // --version) — checking is a stat plus at most one ldconfig, never a
    // download.
    if (!config.program.setupComplete) {
      winston.info('This server is not set up yet — open the address above in a browser to add music folders and an admin account.');
      const wizard = installedPlayerPath();
      if (wizard && playerLoadableHere()) {
        winston.info(`Prefer a guided terminal setup? Run: "${wizard}" setup --server ${protocol}://localhost:${config.program.port}`);
      }
    }

    // A settings change landed while the reboot above was already past its
    // config read (see rebootPending): go straight around again rather than
    // booting the chores below for a config that is already stale. The
    // re-run re-reads the file, so it applies both changes.
    if (rebootPending) {
      rebootPending = false;
      if (completedWrites(config.configFile) > configWritesAtRead) {
        winston.info('A settings change landed after this reboot read the config — rebooting once more to apply it');
        setImmediate(reboot);
        return;
      }
      winston.info('The settings change that arrived during the reboot was already picked up by it');
    }

    const taskQueue = await import('./db/task-queue.js');
    taskQueueMod = taskQueue;
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
    // The separate-port servers are kept listeners (util/kept-listener.js):
    // reboot() deliberately does NOT stop them, so start() here keeps their
    // socket when port/address are unchanged and only recycles it when they
    // are — same rule as the main listener, same Windows/Bun reason. A config
    // that no longer wants them must therefore stop them HERE.
    if (config.program.dlna.mode === 'separate-port') {
      dlnaServer.start();
    } else {
      dlnaServer.stop();
    }
    if (config.program.subsonic.mode === 'separate-port') {
      subsonicServer.start();
    } else {
      subsonicServer.stop();
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
          // Not "disabled this boot" any more: the config says enabled, so
          // the stack's crash-recovery ladder takes over — 5s/15s/60s/5min,
          // never giving up, config-gated so a runtime disable still wins.
          // The likely causes are transient (a flaky first-install sidecar
          // download, a busy data dir, a slow relay handshake), and the ones
          // that aren't stay loudly visible: one warn per attempt, and the
          // admin panel shows "reconnecting" instead of an ambiguous
          // "not joined yet".
          winston.error(`[discovery-p2p] catalog unavailable at boot — retrying on the recovery ladder: ${err.message}`);
          const stack = await import('./state/discovery-p2p-stack.js');
          stack.armBootRetry('boot start failed');
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
  let samePortRelisten = relisten !== null && relisten.port === bind.port;
  if (relisten !== null && !samePortRelisten) {
    winston.info(`Reboot moved the port ${relisten.port} -> ${bind.port}; a conflict on the new port is real, not a release delay`);
  }
  const relistenStartedAt = Date.now();
  let relistenAttempts = 0;
  let relistenLastLoggedAt = 0;
  let relistenDiagnosed = false;
  let rolledBack = false;
  server.on('error', (err) => {
    // Only the CURRENT server may act on its errors. A superseded instance
    // (an overlapping reboot's loser) must never run the exit paths below —
    // it would take the healthy live server down with it.
    if (thisServer !== server) {
      winston.warn(`Ignoring '${err.code || err.message}' from a superseded server instance`);
      try { thisServer.close(); } catch (_) { /* already closed */ }
      return;
    }
    // A reboot that CHANGED the bind to something this machine cannot serve
    // — an address that isn't local (EADDRNOTAVAIL), a privileged or reserved
    // port (EACCES), a port some other program owns (EADDRINUSE on a MOVED
    // port, where a conflict is real). The old bind worked a moment ago; going
    // dark, exiting, and re-exiting on every later boot because the bad value
    // is now on disk (that was the behaviour) helps nobody. Revert instead:
    // put the previous port/address back in the config file, say so loudly,
    // and re-take the bind we just released — with the same-port patience,
    // since it IS the port this process held.
    if (relisten !== null && !rolledBack &&
        (err.code === 'EADDRNOTAVAIL' || err.code === 'EACCES' || err.code === 'EINVAL' ||
         (err.code === 'EADDRINUSE' && !samePortRelisten))) {
      rolledBack = true;
      const rejected = bindLabel(bind);
      bind.port = relisten.port;
      bind.address = relisten.address;
      config.program.port = relisten.port;
      config.program.address = relisten.address;
      samePortRelisten = true;
      winston.error(`The new bind ${rejected} cannot be served (${err.code}${err.message ? `: ${err.message}` : ''}) — reverting to ${bindLabel(bind)} and restoring port/address in the config file`);
      try { fs.writeSync(2, `mStream: bind ${rejected} rejected (${err.code}); staying on ${bindLabel(bind)}\n`); } catch (_) { /* stderr gone */ }
      revertBindInConfig(config.configFile, relisten).catch((revertErr) => {
        winston.error(`Could not restore the previous port/address in ${config.configFile}: ${revertErr.message} — edit it by hand or the next start will fail the same way`);
      });
      setTimeout(() => { if (thisServer === server) { thisServer.listen(bind.port, bind.address); } }, 250);
      return;
    }
    if (err.code === 'EADDRINUSE' && samePortRelisten) {
      relistenAttempts++;
      const waitedMs = Date.now() - relistenStartedAt;
      // Same port, MOVED address (e.g. [::] -> 127.0.0.1): "in use" can be our
      // own child's inherited handle (a wait, as below) or another program on
      // exactly the new address (permanent — the pre-recycle probe can't see
      // that one, since on Linux the exact bind fails against our own socket
      // until we close it). Give it 20 s, then go back to the address that
      // worked rather than sit dark indefinitely; if THAT is held too it is
      // the inherited-handle case, and the unbounded patience below applies.
      if (!rolledBack && relisten.address !== bind.address && waitedMs >= 20000) {
        rolledBack = true;
        const rejected = bindLabel(bind);
        bind.address = relisten.address;
        config.program.address = relisten.address;
        winston.error(`Port ${bind.port} still busy 20s after moving to ${rejected} — reverting to ${bindLabel(bind)} and restoring the address in the config file`);
        revertBindInConfig(config.configFile, relisten).catch((revertErr) => {
          winston.error(`Could not restore the previous address in ${config.configFile}: ${revertErr.message}`);
        });
      }
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
    // and remember it: the in-flight reboot re-reads the config exactly once,
    // at its start, so a save landing after that read is applied by ONE more
    // reboot once this one has re-served (see rebootPending / onListening).
    if (rebootInFlight) {
      rebootPending = true;
      winston.warn('Reboot already in progress — this request will re-run the reboot once it completes');
      return;
    }
    rebootInFlight = true;
    appGeneration++;
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
    // The separate-port DLNA/Subsonic servers are NOT stopped here: they are
    // kept listeners (util/kept-listener.js) and onListening re-ensures them
    // against the re-read config — kept when their bind is unchanged, recycled
    // (with same-port patience) when it isn't, stopped when no longer wanted.
    // Closing them here made every soft reboot on the Windows Bun bundle
    // re-listen against a child's inherited handle, and their re-listen has
    // no second chance: the Subsonic API stayed dead until the next restart.
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

    // Tear down the Iroh tunnel, the federation endpoint (+ its peer bridges)
    // and the discovery-network gossip stack. Each binds its own sockets
    // independent of the HTTP server; each is lazy-imported to match the boot
    // path and to stay a no-op when its native module was never loaded.
    //
    // ALL of these are SEQUENCED before the re-serve, not fired and
    // forgotten. The re-serve now runs tens of milliseconds after this point
    // (the kept-socket swap), while closing an iroh endpoint takes ~1 s: a
    // fire-and-forget stop() meant onListening's start() found the endpoint
    // still set (closing), no-oped, and the late stop then nulled it — Quick
    // Connect and federation dead after ANY reboot-requiring admin save, no
    // error logged, until the next process restart. Same for the discovery
    // stack: an operator who DISABLES it in the config and uses the admin
    // reboot kept publishing until a full restart.
    //
    // The timeout is a LATENCY bound, not the correctness mechanism: a wedged
    // teardown can delay the restart but never block it. Correctness lives in
    // the modules themselves — each keeps an in-flight `stopping` promise,
    // clears its public state up front, and makes a start() wait on the stop
    // (state/iroh.js, state/federation.js, state/discovery-p2p-stack.js). That
    // ordering matters because a full stop can outlast this timeout (the
    // discovery sidecar gets a shutdown-RPC grace AND a SIGKILL fallback), and
    // when it does the restart lands mid-stop and must wait rather than no-op.
    const stopOf = (label, load) => load()
      .catch((err) => winston.warn(`[${label}] stop during reboot failed: ${err.message}`));
    const teardowns = Promise.all([
      stopOf('discovery-p2p', () => import('./state/discovery-p2p-stack.js').then((m) => m.stopDiscoveryP2pStack())),
      stopOf('iroh', () => import('./state/iroh.js').then((m) => m.stop())),
      stopOf('federation-client', () => import('./state/federation-client.js').then((m) => m.stopAll())),
      stopOf('federation', () => import('./state/federation.js').then((m) => m.stop())),
    ]);
    const teardownsDone = Promise.race([
      teardowns,
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
    // Drop the OLD app's in-flight connections after a short grace period, so
    // short writes get a chance to finish but a long transfer (a transcode, a
    // big download) doesn't keep the old app's handlers alive indefinitely —
    // and, on a bind change, so Node's close() can settle (serveIt's recycle
    // path destroys ALL of the old listener's sockets for that; see there).
    // Snapshot, not the live set: connections the kept socket accepts after
    // this moment belong to the stub and then to the new app. And on the
    // kept socket the app swaps ~70 ms in, so by the time this fires an idle
    // keep-alive connection from before the reboot may already be carrying a
    // NEW-app response (a browser's pooled connection starting the next
    // track): destroy only sockets still busy with a response the OLD
    // generation started; leave idle ones and new-generation ones alone.
    // Untagged sockets (a runtime where req.socket isn't the accepted socket)
    // keep the previous behaviour and are destroyed.
    const closingSockets = [...liveSockets];
    const newGeneration = appGeneration;
    setTimeout(() => {
      for (const socket of closingSockets) {
        if (socket._mstreamGen !== undefined && (!socket._mstreamBusy || socket._mstreamGen >= newGeneration)) { continue; }
        try { socket.destroy(); } catch (_) { /* already gone */ }
      }
    }, 1000);
    // serveIt can reject before its listen handler exists (bad SSL certs are
    // the classic: config.setup re-reads the file every reboot, so a rotated
    // cert first fails HERE). Unhandled, that's a raw unhandled rejection
    // with the old app already torn down — the silent death #803 set out to
    // eliminate, just moved to the reboot path.
    // Gate the re-serve on the endpoint/sidecar teardowns finishing (see above).
    teardownsDone.then(() => serveIt(config.configFile, { relisten: previousBind })).catch((rebootErr) => {
      rebootInFlight = false;
      rebootPending = false;
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
