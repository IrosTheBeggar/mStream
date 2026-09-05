import path from 'path';
import child from 'child_process';
import os from 'os';
import Joi from 'joi';
import winston from 'winston';
import { ZipArchive } from 'archiver';
import * as fileExplorer from '../util/file-explorer.js';
import * as admin from '../util/admin.js';
import * as config from '../state/config.js';
import * as dbQueue from '../db/task-queue.js';
import * as imageCompress from '../db/image-compress-manager.js';
import * as transcode from './transcode.js';
import * as updateCheck from '../util/update-check.js';
import * as db from '../db/manager.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as discoveryExport from '../db/discovery-export.js';
import { EMBEDDING_MODELS } from '../db/discovery-features-lib.js';
import * as discoveryP2p from '../state/discovery-p2p.js';
import * as sidecarBootstrap from '../util/p2p-sidecar-bootstrap.js';
import * as discoveryCatalog from '../state/discovery-catalog.js';
import * as discoverySeeds from '../state/discovery-seeds.js';
import * as discoveryStack from '../state/discovery-p2p-stack.js';
import * as discoveryPeerDbs from '../state/discovery-peer-dbs.js';
import * as logger from '../logger.js';
import { joiValidate } from '../util/validation.js';
import { isAdminAllowed } from '../util/admin-network.js';
import WebError from '../util/web-error.js';
import { bootRustPlayer, killRustPlayer, getActiveBackend, getDetectedCliPlayers, refreshDetectedCliPlayers, playerBinaryFetchable } from './server-playback.js';
import * as lyricsLrclib from './lyrics-cache.js';
import { warmScrobbleUser } from './scrobbler.js';
// Torrent admin endpoints live in their own module — see
// admin-torrent.js. We call adminTorrent.register(mstream) from
// setup() below, after the admin guard is registered, so the torrent
// routes inherit the same auth checks as every other /admin/* path.
import * as adminTorrent from './admin-torrent.js';
// Federation admin endpoints, same split (see admin-federation.js).
import * as adminFederation from './admin-federation.js';

import { getTransCodecs, getTransBitrates } from '../api/transcode.js';

export function setup(mstream) {
  mstream.all('/api/v1/admin/{*path}', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    // A non-admin caller is authenticated fine — they just lack the role. That
    // is 403, not 405, and it is NOT "Admin API Disabled": the API is up, this
    // user simply isn't allowed. The old 405 + shared message made a role
    // failure indistinguishable from the whole API being switched off.
    if (req.user.admin !== true) { return res.status(403).json({ error: 'Admin access required' }); }
    // Application-level IP gate (adminAccess.mode = all|none|localhost|whitelist).
    // 'none' is already caught by the lockAdmin check above; localhost/whitelist
    // are enforced here. Ordering: none-check(405) -> admin-role(403) -> network(403).
    if (!isAdminAllowed(req)) { return res.status(403).json({ error: 'Admin access restricted to local network' }); }
    next();
  });

  mstream.post('/api/v1/admin/lock-api', async (req, res) => {
    const schema = Joi.object({ lock: Joi.boolean().required() });
    joiValidate(schema, req.body);

    await admin.lockAdminApi(req.body.lock);
    res.json({});
  });

  // ── Iroh remote-access tunnel ────────────────────────────────────────
  // Admin-only (inherits the guard above). The status payload includes the
  // composite QR ticket, which carries the connect secret — hence admin-only.
  // The tunnel is independent of the HTTP server, so enable/disable and secret
  // rotation take effect LIVE (start/stop the endpoint) without a reboot.

  mstream.get('/api/v1/admin/iroh', async (req, res) => {
    const enabled = config.program.iroh.enabled === true;
    let available = true;
    let endpointId = null;
    let relayUrl = null;
    let qr = null;
    try {
      const iroh = await import('../state/iroh.js');
      endpointId = iroh.getEndpointId();
      if (endpointId) {
        qr = iroh.getTicket();
        const addr = iroh.getEndpointAddr();
        relayUrl = addr ? addr.relayUrl() : null;
      }
    } catch (_err) {
      available = false; // native binary not present on this platform
    }
    res.json({ enabled, available, running: endpointId !== null, endpointId, online: relayUrl !== null, relayUrl, qr });
  });

  mstream.post('/api/v1/admin/iroh', async (req, res) => {
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);
    const enabled = req.body.enabled;

    const raw = await admin.loadFile(config.configFile);
    if (!raw.iroh) { raw.iroh = {}; }
    raw.iroh.enabled = enabled;
    await admin.saveFile(raw, config.configFile);
    config.program.iroh.enabled = enabled;

    try {
      const iroh = await import('../state/iroh.js');
      if (enabled) {
        await iroh.start({
          targetPort: config.program.port,
          secretKey: config.program.iroh.secretKey,
          connectSecret: config.program.iroh.connectSecret,
        });
      } else {
        await iroh.stop();
      }
      res.json({ enabled, available: true });
    } catch (err) {
      winston.error('[iroh] admin toggle failed — tunnel unavailable on this platform', { stack: err });
      res.json({ enabled, available: false });
    }
  });

  mstream.post('/api/v1/admin/iroh/rotate-secret', async (req, res) => {
    const newSecret = await config.asyncRandom(32);
    const raw = await admin.loadFile(config.configFile);
    if (!raw.iroh) { raw.iroh = {}; }
    raw.iroh.connectSecret = newSecret;
    await admin.saveFile(raw, config.configFile);
    config.program.iroh.connectSecret = newSecret;

    // Restart the tunnel (if running) so the new secret takes effect and the QR
    // updates. Old QRs stop working — that's the point of rotation.
    try {
      const iroh = await import('../state/iroh.js');
      if (config.program.iroh.enabled) {
        await iroh.stop();
        await iroh.start({
          targetPort: config.program.port,
          secretKey: config.program.iroh.secretKey,
          connectSecret: config.program.iroh.connectSecret,
        });
      }
      res.json({ rotated: true, available: true });
    } catch (err) {
      winston.error('[iroh] secret rotation failed', { stack: err });
      res.json({ rotated: true, available: false });
    }
  });

  mstream.get('/api/v1/admin/file-explorer/win-drives', (req, res) => {
    if (os.platform() !== 'win32') {
      return res.status(400).json({});
    }

    child.exec('wmic logicaldisk get name', (error, stdout) => {
      const drives = stdout.split('\r\r\n')
        .filter(value => /[A-Za-z]:/.test(value))
        .map(value => value.trim() + '\\')
      res.json(drives);
    });
  });

  // The admin file explorer can view the entire system
  mstream.post("/api/v1/admin/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      joinDirectory: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    // Handle home directory
    let thisDirectory = req.body.directory;
    if (req.body.directory === '~') {
      thisDirectory = os.homedir();
    }

    if (req.body.joinDirectory) {
      thisDirectory = path.join(thisDirectory, req.body.joinDirectory);
    }

    const folderContents = await fileExplorer.getDirectoryContents(thisDirectory, {}, true);

    res.json({
      path: thisDirectory,
      directories: folderContents.directories,
      files: folderContents.files
    });
  });

  mstream.get("/api/v1/admin/directories", (req, res) => {
    const libraries = db.getAllLibraries();
    const result = {};
    for (const lib of libraries) {
      result[lib.name] = {
        // Numeric library id, exposed so admin UI flows that need to
        // address libraries by id (e.g. /api/v1/admin/backup/* — the
        // backup module joins on libraries.id) can avoid a second
        // lookup. Existing consumers ignore unknown fields.
        id: lib.id,
        root: lib.root_path,
        type: lib.type,
        // V21: per-library boolean. Admin panel renders a simple
        // on/off toggle; default false matches the Rust scanner.
        followSymlinks: lib.follow_symlinks === 1,
      };
    }
    res.json(result);
  });

  mstream.get("/api/v1/admin/db/params", (req, res) => {
    res.json(config.program.scanOptions);
  });

  mstream.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    const schema = Joi.object({
      scanInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanInterval(req.body.scanInterval);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    const schema = Joi.object({
      skipImg: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editSkipImg(req.body.skipImg);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    const schema = Joi.object({
      bootScanDelay:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanDelay(req.body.bootScanDelay);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/compress-image", async (req, res) => {
    const schema = Joi.object({
      compressImage:  Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCompressImages(req.body.compressImage);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/scan-commit-interval", async (req, res) => {
    // Mirrors the soft cap in src/state/config.js's Joi schema —
    // clamp+warn to 1000 instead of 400-rejecting. Same reasoning as
    // there: a typo in an admin slider shouldn't take the API down,
    // and the warning makes it visible in logs. We pass `value` (the
    // post-clamp number) to the persister so the stored config matches
    // the running config, not whatever oversized number the request
    // body originally carried.
    const schema = Joi.object({
      scanCommitInterval: Joi.number().integer().min(1).required().custom((value) => {
        if (value > 1000) {
          winston.warn(`scanCommitInterval=${value} from admin POST exceeds 1000 cap; clamping to 1000`);
          return 1000;
        }
        return value;
      })
    });
    const { value } = joiValidate(schema, req.body);

    await admin.editScanCommitInterval(value.scanCommitInterval);
    res.json({});
  });

  // 0 = auto (Rust scanner picks half the available cores). Operators
  // who want to push harder during a known-quiet maintenance window
  // can set N explicitly; pinning to 1 keeps the legacy single-
  // threaded behaviour. Only the Rust scanner honours this — the JS
  // fallback ignores the field, see src/db/scanner.mjs.
  mstream.post("/api/v1/admin/db/params/scan-threads", async (req, res) => {
    const schema = Joi.object({
      scanThreads: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanThreads(req.body.scanThreads);
    res.json({});
  });

  // Toggle the post-scan waveform enrichment pass. true (default) =
  // task-queue chains a `--waveform-scan` pass after every scan,
  // writing <hash>.bin files in the background (the scan itself no
  // longer decodes anything). false = no pass; the on-demand
  // /api/v1/db/waveform endpoint generates via ffmpeg on first
  // playback instead. Flipping it ON enqueues a pass immediately so
  // the backfill doesn't wait for the next scan.
  mstream.post("/api/v1/admin/db/params/generate-waveforms", async (req, res) => {
    const schema = Joi.object({
      generateWaveforms: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editGenerateWaveforms(req.body.generateWaveforms);
    if (req.body.generateWaveforms === true) {
      dbQueue.addWaveformTask();
    }
    res.json({});
  });

  // Toggle the post-scan essentia BPM/key analysis pass. Tag-sourced BPM/key
  // is always ingested during the scan regardless; this gates the audio-
  // analysis enrichment worker that fills the gaps for tag-less tracks.
  // Flipping it ON enqueues an immediate pass (through the SAME guarded path
  // as the scan-drain trigger — config flag, ffmpeg-resolved, and anything-
  // eligible checks all apply) so the user sees results without waiting for
  // the next scan.
  mstream.post("/api/v1/admin/db/params/analyze-bpm", async (req, res) => {
    const schema = Joi.object({
      analyzeBpm: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeBpm(req.body.analyzeBpm);
    if (req.body.analyzeBpm === true) { dbQueue.maybeEnqueueAudioAnalysis(); }
    res.json({});
  });

  // Dot-entry ignore toggles (default OFF). Live: the next scan of any
  // vpath picks the flags up from config.program, skips matching entries
  // in the walk, and converges already-indexed matching rows out via the
  // sweep (flipping OFF brings them back on the next scan). No immediate
  // scan is enqueued — the change is about what future scans index.
  mstream.post("/api/v1/admin/db/params/ignore-dot-files", async (req, res) => {
    const schema = Joi.object({
      ignoreDotFiles: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editIgnoreDotFiles(req.body.ignoreDotFiles);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/ignore-dot-folders", async (req, res) => {
    const schema = Joi.object({
      ignoreDotFolders: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editIgnoreDotFolders(req.body.ignoreDotFolders);
    res.json({});
  });

  // Live toggle for the filesystem watcher: persists, then starts or
  // stops the watchers in-process — no reboot. Watchers only ever
  // ENQUEUE scans (through the same task-queue dedup as every other
  // trigger), so flipping this is always safe.
  mstream.post("/api/v1/admin/db/params/watcher-enabled", async (req, res) => {
    const schema = Joi.object({
      watcherEnabled: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editWatcherEnabled(req.body.watcherEnabled);
    if (req.body.watcherEnabled === true) { dbQueue.startLibraryWatchers(); }
    else { dbQueue.stopLibraryWatchers(); }
    res.json({});
  });

  // Tracks analysed per essentia pass (bounds how long one batch holds the
  // serial task slot; the worker also caps wall-clock and re-enqueues a
  // backlog). Mirrors auto-album-art-per-run; takes effect on the next pass.
  mstream.post("/api/v1/admin/db/params/analyze-bpm-per-run", async (req, res) => {
    const schema = Joi.object({
      analyzeBpmPerRun: Joi.number().integer().min(1).max(10000).required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeBpmPerRun(req.body.analyzeBpmPerRun);
    res.json({});
  });

  // BPM estimation method for the essentia pass. 'multifeature' = accurate +
  // confidence-gated; 'degara' = ~6× faster, no confidence output (every
  // in-range estimate is written). Takes effect on the next pass.
  mstream.post("/api/v1/admin/db/params/analyze-bpm-method", async (req, res) => {
    const schema = Joi.object({
      analyzeBpmMethod: Joi.string().valid('multifeature', 'degara').required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeBpmMethod(req.body.analyzeBpmMethod);
    res.json({});
  });

  // Mid-track analysis window (seconds) for the essentia pass: 0 = whole
  // file, otherwise 30–600. Mirrors the config-side rule; takes effect on
  // the next pass.
  mstream.post("/api/v1/admin/db/params/analyze-bpm-window-sec", async (req, res) => {
    const schema = Joi.object({
      analyzeBpmWindowSec: Joi.alternatives().try(
        Joi.number().integer().min(30).max(600),
        Joi.number().valid(0)
      ).required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeBpmWindowSec(req.body.analyzeBpmWindowSec);
    res.json({});
  });

  // Toggle the AcoustID identification pass (chromaprint fingerprint →
  // MusicBrainz recording MBID for tracks whose tags carry none). Default
  // OFF — it sends acoustic fingerprints to an external service. Flipping
  // ON enqueues an immediate pass through the same guarded path as the
  // scan-drain trigger (config, API key, rust-parser, eligibility).
  mstream.post("/api/v1/admin/db/params/analyze-acoustid", async (req, res) => {
    const schema = Joi.object({
      analyzeAcoustid: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAnalyzeAcoustid(req.body.analyzeAcoustid);
    if (req.body.analyzeAcoustid === true) { dbQueue.maybeEnqueueAcoustid(); }
    res.json({});
  });

  // Tracks identified per AcoustID pass. Mirrors analyze-bpm-per-run.
  mstream.post("/api/v1/admin/db/params/acoustid-per-run", async (req, res) => {
    const schema = Joi.object({
      acoustidPerRun: Joi.number().integer().min(1).max(10000).required()
    });
    joiValidate(schema, req.body);

    await admin.editAcoustidPerRun(req.body.acoustidPerRun);
    res.json({});
  });

  // Toggle collection of music-discovery data (embeddings + external IDs)
  // into the separate discovery.db. Flipping it ON creates/migrates the DB
  // immediately AND enqueues an embedding pass (through the SAME guarded
  // path as the scan-drain trigger — config, ffmpeg, and anything-eligible
  // checks all apply) so the user sees vectors without waiting for the next
  // scan. Flipping OFF stops future collection but deliberately keeps the
  // data — deleting {dbDirectory}/discovery.db is the operator's explicit
  // purge.
  mstream.post("/api/v1/admin/db/params/collect-discovery-data", async (req, res) => {
    const schema = Joi.object({
      collectDiscoveryData: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCollectDiscoveryData(req.body.collectDiscoveryData);
    if (req.body.collectDiscoveryData === true) {
      discoveryDb.initDiscoveryDb();
      dbQueue.maybeEnqueueDiscovery();
    }
    res.json({});
  });

  // Tracks embedded per discovery pass (bounds how long one batch holds the
  // serial task slot; the worker also caps wall-clock and re-enqueues a
  // backlog). Takes effect on the next pass.
  mstream.post("/api/v1/admin/db/params/discovery-per-run", async (req, res) => {
    const schema = Joi.object({
      discoveryPerRun: Joi.number().integer().min(1).max(10000).required()
    });
    joiValidate(schema, req.body);

    await admin.editDiscoveryPerRun(req.body.discoveryPerRun);
    res.json({});
  });

  // Which embedding engine the discovery pass runs — validated against the
  // model registry. Changing it starts an in-place migration: the next
  // passes re-embed every row pinned to the previous model (kicked off
  // immediately when collection is on, same guarded path as the toggle).
  mstream.post("/api/v1/admin/db/params/discovery-model", async (req, res) => {
    const schema = Joi.object({
      discoveryModel: Joi.string().valid(...Object.keys(EMBEDDING_MODELS)).required()
    });
    joiValidate(schema, req.body);

    await admin.editDiscoveryModel(req.body.discoveryModel);
    dbQueue.maybeEnqueueDiscovery();
    res.json({});
  });

  // Build a fresh export snapshot of discovery.db — a cleaned copy holding
  // only the share-safe columns (no local hashes, no cooldown ledger, no
  // export salt) plus a manifest with sha256/row count. Returns the
  // manifest. 404 until discovery collection has been enabled at least
  // once; 409 while a build is already running (SQLite would reject the
  // second ATTACH anyway — this just gives it a clean status code).
  let discoveryExportInFlight = false;
  mstream.post("/api/v1/admin/db/discovery-export", async (req, res) => {
    if (!discoveryDb.openDiscoveryDbIfExists()) {
      throw new WebError('discovery data collection has never been enabled', 404);
    }
    if (discoveryExportInFlight) {
      throw new WebError('a discovery export is already in progress', 409);
    }
    discoveryExportInFlight = true;
    try {
      res.json(await discoveryExport.exportDiscoverySnapshot());
    } finally {
      discoveryExportInFlight = false;
    }
  });

  // Manifest of the current snapshot — lets a caller check size / row count
  // / model compatibility (and later, a peer decide whether to re-pull)
  // without downloading the file.
  mstream.get("/api/v1/admin/db/discovery-export/manifest", (req, res) => {
    const manifest = discoveryExport.readManifest();
    if (!manifest) { throw new WebError('no discovery export has been built yet', 404); }
    res.json(manifest);
  });

  // The snapshot itself. res.download → sendFile supports HTTP Range, so
  // large snapshots are resumable (which also makes this endpoint reusable
  // over the iroh pairing tunnel as-is). dotfiles:'allow' because sendFile's
  // default refuses any path CONTAINING a dot-segment — and dbDirectory
  // commonly lives under one on Linux installs (~/.config/mstream,
  // ~/.mstream), which would turn every download into a baffling 404.
  mstream.get("/api/v1/admin/db/discovery-export/download", (req, res) => {
    if (!discoveryExport.snapshotExists()) {
      throw new WebError('no discovery export has been built yet', 404);
    }
    res.download(discoveryExport.snapshotPath(), 'discovery-export.db', { dotfiles: 'allow' });
  });

  // ── Discovery P2P (p2p-sidecar: iroh-blobs snapshot sharing) ────────────
  // All three routes 403 until config.program.discoveryP2p.enabled — the
  // sidecar publishes library metadata to whoever holds a ticket, so the
  // operator opts in via config, not by accident through the API.
  const requireP2pEnabled = () => {
    if (!config.program.discoveryP2p.enabled) {
      throw new WebError('discovery P2P is disabled (config: discoveryP2p.enabled)', 403);
    }
  };

  // Sidecar status. Deliberately side-effect free: reports the sidecar as
  // stopped rather than starting it (publish/fetch/join are the lazy-starters).
  // `ticket` is what another operator pastes into their bootstrapPeers config
  // (or POSTs to /join) to befriend this server.
  mstream.get("/api/v1/admin/discovery/p2p/status", async (req, res) => {
    // Live mesh state from the sidecar — joined + neighbor count is the
    // only way an operator can tell "am I actually connected to the
    // network?" as opposed to "the process is running".
    let joined = false;
    let neighbors = 0;
    if (discoveryP2p.isRunning()) {
      try {
        const s = await discoveryP2p.status();
        joined = s.joined === true;
        neighbors = Number(s.neighbors) || 0;
      } catch (err) {
        winston.warn(`discovery p2p sidecar status query failed: ${err.message}`);
      }
    }
    res.json({
      enabled: config.program.discoveryP2p.enabled,
      binaryFound: discoveryP2p.resolveSidecarBinary() !== null,
      // Additive: lets the UI say "will be downloaded on enable" instead of
      // a dead-end "binary missing" when the manifest covers this platform.
      binaryFetchable: sidecarBootstrap.canAutoFetch(),
      running: discoveryP2p.isRunning(),
      endpointId: discoveryP2p.getEndpointId(),
      ticket: discoveryP2p.getEndpointTicket(),
      joined,
      neighbors,
      // Who those neighbors are (endpoint ids), tracked from the sidecar's
      // neighbor events. Bounded by the gossip fan-out (hyparview active
      // view), so never more than a handful. The panel's mesh map joins
      // these against the catalog for names; `neighbors` above (the
      // sidecar's own count) stays the authority for how many.
      neighborIds: discoveryP2p.getNeighborIds(),
      // Sidecar memory + watchdog posture (#885): lastRssMb is the
      // mesh-health watch's most recent reading (null before the first
      // tick or where RSS can't be read), restarts counts watchdog kills
      // this process lifetime, maxRssMb echoes the ceiling (0 = off).
      watchdog: {
        ...discoverySeeds.getWatchdogState(),
        maxRssMb: config.program.discoveryP2p.sidecarMaxRssMb,
      },
      // Crash-recovery posture: attempts > 0 = recovery owns the sidecar
      // right now (it zeroes on success/stop); retryPending = a ladder
      // timer is armed. Lets the panel say "reconnecting, attempt N"
      // instead of rendering a dead sidecar as "searching for peers".
      recovery: discoveryStack.getRecoveryState(),
      knownPeers: discoveryCatalog.size(),
      communitySeeds: config.program.discoveryP2p.useCommunitySeeds,
      serverName: config.program.discoveryP2p.serverName,
      serverDescription: config.program.discoveryP2p.serverDescription,
      maxPeerDbStorageMb: config.program.discoveryP2p.maxPeerDbStorageMb,
      autoFetchCount: config.program.discoveryP2p.autoFetchCount,
      rotationDays: config.program.discoveryP2p.rotationDays,
      peerRetentionDays: config.program.discoveryP2p.peerRetentionDays,
      blockedPeers: config.program.discoveryP2p.blockedPeers,
    });
  });

  // The Discovery panel's Activity feed: the discovery/p2p slice of the log
  // stream from its own fixed-size ring (logger.js) — mesh joins, snapshot
  // fetches, rotation and recovery lines, immune to wash-out from chatty
  // non-discovery logging. Same delta-poll contract as /admin/logs/recent;
  // the two endpoints' seq cursors are independent.
  mstream.get("/api/v1/admin/discovery/p2p/activity", (req, res) => {
    requireP2pEnabled();
    res.json(logger.getP2pActivity(req.query.since));
  });

  // The catalog: every peer we've heard a signed announcement from (newest
  // per peer), enriched with what the shelf knows (fetched? current?) and
  // sorted most-useful-first: online-now (heard within ~90s — announcers
  // re-broadcast every ~15s), then by library size. True popularity
  // (seeder counts) arrives with the N3 provider tracking.
  mstream.get("/api/v1/admin/discovery/p2p/catalog", (req, res) => {
    requireP2pEnabled();
    const now = Date.now();
    const localModel = discoveryDb.openDiscoveryDbIfExists()
      ? discoveryDb.getMeta('embedding_model_id') : null;
    const peers = discoveryCatalog.list().map((entry) => {
      const held = discoveryPeerDbs.get(entry.from);
      return {
        ...entry,
        online: now - Date.parse(entry.updatedAt) < 90 * 1000,
        // Live holders of this peer's current snapshot (from signed holds
        // beacons) — the observable popularity signal. The author beacons
        // its own hash too, so a healthy snapshot shows at least 1.
        seeders: discoveryCatalog.seederCount(entry.payload.hash),
        fetched: held ? {
          snapshotSeq: held.snapshotSeq,
          stale: (entry.payload.snapshotSeq || 0) > (held.snapshotSeq || 0),
          sizeBytes: held.sizeBytes,
          fetchedAt: held.fetchedAt,
          firstFetchedAt: held.firstFetchedAt,
          pinned: held.pinned === true,
        } : null,
        // null = unknown (no local model established yet), not "incompatible"
        compatible: localModel ? entry.payload.modelId === localModel : null,
      };
    }).sort((a, b) => (b.seeders - a.seeders)
      || (b.online - a.online)
      || ((b.payload.rowCount || 0) - (a.payload.rowCount || 0)));
    // Hide-by-default: an UNHELD catalog peer whose announced model cannot
    // power the local similar search is dead weight in the listing — and
    // test networks' throwaway announcements (the "Stranger" ghosts,
    // modelId test-model) land exactly in this class, so they stop
    // cluttering real servers' panels. Held/pinned peers always show
    // (they occupy the operator's shelf; hiding owned state would
    // mislead), unknown compatibility (no local model yet) hides nothing,
    // and ?includeIncompatible=1 shows everything — the blocklist and
    // debugging still need eyes on the full catalog.
    const includeIncompatible = req.query.includeIncompatible === '1';
    const visible = includeIncompatible
      ? peers
      : peers.filter((peer) => peer.compatible !== false || peer.fetched !== null);
    res.json({
      peers: visible,
      hiddenIncompatible: peers.length - visible.length,
      localModelId: localModel,
      autoFetch: config.program.discoveryP2p.autoFetch,
      storage: {
        usedBytes: discoveryPeerDbs.totalBytes(),
        capBytes: config.program.discoveryP2p.maxPeerDbStorageMb * 1024 * 1024,
      },
    });
  });

  // Manual shelf management: fetch a specific catalog peer's snapshot now
  // (still subject to the blocklist + storage cap), or drop one. A manual
  // download PINS the entry — an admin's explicit choice must not be
  // silently rotated away later; the pin route below undoes it.
  mstream.post("/api/v1/admin/discovery/p2p/peer-dbs/fetch", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({ endpointId: Joi.string().hex().length(64).required() });
    joiValidate(schema, req.body);
    try {
      res.json(await discoveryPeerDbs.fetchPeer(req.body.endpointId, { pinned: true }));
    } catch (err) {
      winston.warn(`discovery peer-db fetch failed for admin '${req.user?.username}' (peer ${req.body.endpointId.slice(0, 12)}…): ${err.message}`);
      throw new WebError(`fetch failed: ${err.message}`, 500);
    }
  });

  // Rotation immunity for one downloaded snapshot. 404 when there's nothing
  // downloaded to pin — pinning is a shelf property, not a catalog one.
  mstream.post("/api/v1/admin/discovery/p2p/peer-dbs/pin", (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      endpointId: Joi.string().hex().length(64).required(),
      pinned: Joi.boolean().required(),
    });
    joiValidate(schema, req.body);
    if (!discoveryPeerDbs.setPinned(req.body.endpointId, req.body.pinned)) {
      throw new WebError('no fetched snapshot for that peer', 404);
    }
    res.json({});
  });

  mstream.post("/api/v1/admin/discovery/p2p/peer-dbs/remove", (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({ endpointId: Joi.string().hex().length(64).required() });
    joiValidate(schema, req.body);
    if (!discoveryPeerDbs.removePeerDb(req.body.endpointId)) {
      throw new WebError('no fetched snapshot for that peer', 404);
    }
    res.json({});
  });

  // Forget a catalog peer right now instead of waiting out the retention
  // window. Same pin rule as the automatic prune: a peer whose snapshot is
  // on the local shelf stays — forgetting it would orphan the downloaded
  // file invisibly (remove the snapshot first, then forget). Reversible by
  // nature: the peer re-enters the catalog on its next announcement.
  mstream.post("/api/v1/admin/discovery/p2p/forget", (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({ endpointId: Joi.string().hex().length(64).required() });
    joiValidate(schema, req.body);
    if (discoveryPeerDbs.get(req.body.endpointId)) {
      throw new WebError('peer has a downloaded snapshot — remove the snapshot first', 409);
    }
    if (!discoveryCatalog.forget(req.body.endpointId)) {
      throw new WebError('unknown peer — not in the catalog', 404);
    }
    res.json({});
  });

  // Block a peer — the abuse lever, previously config-file-only. Blocked
  // means "doesn't exist": future announcements are refused (see
  // discovery-catalog.record), holds beacons ignored, snapshots never
  // fetched — and this route makes the present match by dropping any
  // downloaded snapshot (re-fetchable after an unblock) and the catalog
  // row in the same action.
  mstream.post("/api/v1/admin/discovery/p2p/block", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({ endpointId: Joi.string().hex().length(64).required() });
    joiValidate(schema, req.body);
    if (req.body.endpointId === discoveryP2p.getEndpointId()) {
      throw new WebError('cannot block this server itself', 400);
    }
    await admin.editAddBlockedPeer(req.body.endpointId);
    discoveryPeerDbs.removePeerDb(req.body.endpointId);
    discoveryCatalog.forget(req.body.endpointId);
    res.json({});
  });

  // Unblock: the peer re-enters the catalog on its next announcement
  // (~15s while it's online); nothing to restore proactively.
  mstream.post("/api/v1/admin/discovery/p2p/unblock", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({ endpointId: Joi.string().hex().length(64).required() });
    joiValidate(schema, req.body);
    await admin.editRemoveBlockedPeer(req.body.endpointId);
    res.json({});
  });

  // Publish the current export snapshot and broadcast its signed
  // announcement to the catalog topic. 404 until an export exists.
  mstream.post("/api/v1/admin/discovery/p2p/announce", async (req, res) => {
    requireP2pEnabled();
    if (!discoveryExport.snapshotExists()) {
      throw new WebError('no discovery export has been built yet — build one first (POST /api/v1/admin/db/discovery-export)', 404);
    }
    try {
      res.json(await discoveryP2p.announceCurrentSnapshot());
    } catch (err) {
      winston.warn(`discovery P2P announce failed for admin '${req.user?.username}': ${err.message}`);
      throw new WebError(`announce failed: ${err.message}`, 500);
    }
  });

  // The p2p master switch, runtime edition — what the config-file flag +
  // reboot used to be. Enabling FORCES discovery data collection on (the
  // network is useless without embeddings; the UI's confirm dialog says so)
  // through the exact same steps as the collect-discovery-data route, then
  // starts the same runtime stack boot runs. Disabling stops the stack but
  // deliberately leaves collection on — local Discover/similar features
  // don't depend on the network. NOT behind requireP2pEnabled, obviously.
  mstream.post("/api/v1/admin/discovery/p2p/enabled", async (req, res) => {
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      // The enable-flow checkbox: also open the federation-requests inbox,
      // which requires the federation feature itself — this orchestrates
      // both. Only meaningful with enabled=true; a partial federation
      // failure leaves discovery ON and reports the cause in the response.
      acceptFederationRequests: Joi.boolean().optional(),
    });
    joiValidate(schema, req.body);
    const stack = await import('../state/discovery-p2p-stack.js');

    if (req.body.enabled === false) {
      await admin.editDiscoveryP2pEnabled(false);
      try {
        await stack.stopDiscoveryP2pStack();
      } catch (err) {
        // Already persisted off; every route gate reads the flag live, so
        // the feature IS off — a shutdown hiccup only merits a log line.
        winston.warn(`discovery P2P stack stop failed for admin '${req.user?.username}': ${err.message}`);
      }
      return res.json({ enabled: false });
    }

    // Missing binary is only a hard stop when it can't be fetched either —
    // otherwise startDiscoveryP2pStack() below downloads it (sha256-pinned by
    // the committed manifest) as part of the start, and a failure there rolls
    // the flag back with the download's own cause.
    if (discoveryP2p.resolveSidecarBinary() === null && !sidecarBootstrap.canAutoFetch()) {
      throw new WebError('the p2p-sidecar binary is missing for this platform and no downloadable build is published — the network cannot be enabled', 503);
    }
    const collectForced = config.program.scanOptions.collectDiscoveryData !== true;
    if (collectForced) {
      await admin.editCollectDiscoveryData(true);
      discoveryDb.initDiscoveryDb();
      dbQueue.maybeEnqueueDiscovery();
    }
    await admin.editDiscoveryP2pEnabled(true);
    try {
      await stack.startDiscoveryP2pStack();
    } catch (err) {
      // Roll the flag back so the config file never claims a state the
      // process didn't reach (collection stays on — it's independently
      // useful and harmless). The operator gets the cause verbatim.
      winston.warn(`discovery P2P stack start failed for admin '${req.user?.username}': ${err.message}`);
      await admin.editDiscoveryP2pEnabled(false);
      await stack.stopDiscoveryP2pStack().catch(() => {});
      throw new WebError(`failed to start the discovery network: ${err.message}`, 500);
    }

    // The "also accept federation requests" checkbox: turn federation on
    // (endpoint included) and open the inbox, atomically from the UI's
    // point of view. Discovery is already up and STAYS up on failure here
    // — the checkbox is an add-on, not a condition; the operator gets the
    // cause in `federationError` and can retry from the Federation tab.
    let federationError = null;
    if (req.body.acceptFederationRequests === true) {
      const prior = {
        enabled: config.program.federation.enabled === true,
        acceptRequests: config.program.federation.acceptRequests === true,
      };
      try {
        const raw = await admin.loadFile(config.configFile);
        if (!raw.federation) { raw.federation = {}; }
        raw.federation.enabled = true;
        raw.federation.acceptRequests = true;
        await admin.saveFile(raw, config.configFile);
        config.program.federation.enabled = true;
        config.program.federation.acceptRequests = true;

        const federation = await import('../state/federation.js');
        await federation.start({
          targetPort: config.program.port,
          secretKey: config.program.federation.secretKey,
        });
        const engine = await import('../state/federation-requests.js');
        await engine.pushAcceptPolicy();
        winston.info(`discovery P2P enabled with the federation-requests inbox by admin '${req.user?.username}'`);
      } catch (err) {
        winston.warn(`federation-inbox enable failed for admin '${req.user?.username}' — discovery stays on: ${err.message}`);
        federationError = err.message;
        // Roll the federation flags back to what they were — never
        // disable a federation the operator had on before this call.
        try {
          const raw = await admin.loadFile(config.configFile);
          if (!raw.federation) { raw.federation = {}; }
          raw.federation.enabled = prior.enabled;
          raw.federation.acceptRequests = prior.acceptRequests;
          await admin.saveFile(raw, config.configFile);
        } catch (rollbackErr) {
          winston.warn(`federation flag rollback failed: ${rollbackErr.message}`);
        }
        config.program.federation.enabled = prior.enabled;
        config.program.federation.acceptRequests = prior.acceptRequests;
      }
    }
    res.json({
      enabled: true, collectForced,
      ...(req.body.acceptFederationRequests === true
        ? { acceptRequests: federationError === null, ...(federationError ? { federationError } : {}) }
        : {}),
    });
  });

  // Disk cap for fetched peer snapshots. Live: the fetch paths read the
  // config fresh per download, so no restart and no stack bounce. Bounds
  // mirror the config Joi (discoveryP2pOptions.maxPeerDbStorageMb).
  // Lowering below current usage blocks new fetches but evicts nothing —
  // removal stays an explicit operator action.
  mstream.post("/api/v1/admin/discovery/p2p/max-storage", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      maxPeerDbStorageMb: Joi.number().integer().min(10).max(100000).required(),
    });
    joiValidate(schema, req.body);
    await admin.editMaxPeerDbStorageMb(req.body.maxPeerDbStorageMb);
    res.json({});
  });

  // How many peer snapshots auto-fetch keeps on the shelf. Live: the
  // reconcile pass reads the config fresh each run, so no restart and no
  // stack bounce. Bounds mirror the config Joi
  // (discoveryP2pOptions.autoFetchCount). 0 stops automatic downloads
  // (manual downloads from the catalog still work); lowering below the
  // current shelf count evicts nothing — removal stays an explicit
  // operator action.
  mstream.post("/api/v1/admin/discovery/p2p/auto-fetch-count", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      autoFetchCount: Joi.number().integer().min(0).max(50).required(),
    });
    joiValidate(schema, req.body);
    await admin.editAutoFetchCount(req.body.autoFetchCount);
    res.json({});
  });

  // How many days a downloaded snapshot may sit on a full shelf before the
  // hourly rotation pass may swap it for a peer we don't hold (0 = never
  // rotate). Live: the pass reads the config fresh each run, so no restart
  // and no stack bounce. Bounds mirror the config Joi
  // (discoveryP2pOptions.rotationDays). Rotation only ever SWAPS — it never
  // shrinks the shelf — and pinned entries are exempt regardless.
  mstream.post("/api/v1/admin/discovery/p2p/rotation", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      rotationDays: Joi.number().integer().min(0).max(3650).required(),
    });
    joiValidate(schema, req.body);
    await admin.editRotationDays(req.body.rotationDays);
    res.json({});
  });

  // RSS ceiling (MB) for the sidecar memory watchdog (#885); 0 turns the
  // watchdog off. Live: the mesh-health watch reads the config fresh every
  // tick, so the next tick enforces the new ceiling — no restart and no
  // stack bounce. Bounds mirror the config Joi
  // (discoveryP2pOptions.sidecarMaxRssMb).
  mstream.post("/api/v1/admin/discovery/p2p/sidecar-max-rss", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      sidecarMaxRssMb: Joi.number().integer().min(0).max(100000).required(),
    });
    joiValidate(schema, req.body);
    await admin.editSidecarMaxRssMb(req.body.sidecarMaxRssMb);
    res.json({});
  });

  // How long a silent peer stays in the catalog before the hourly prune
  // pass forgets it (0 = forever). Live: the pass reads the config fresh, so
  // no restart and no stack bounce. Bounds mirror the config Joi
  // (discoveryP2pOptions.peerRetentionDays). Peers whose snapshot is on the
  // local shelf are never pruned regardless of this value.
  mstream.post("/api/v1/admin/discovery/p2p/peer-retention", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      peerRetentionDays: Joi.number().integer().min(0).max(3650).required(),
    });
    joiValidate(schema, req.body);
    await admin.editPeerRetentionDays(req.body.peerRetentionDays);
    res.json({});
  });

  // The display name peers see next to the description. Same save +
  // re-announce contract as the description route below; the catalog treats
  // a name edit under an unchanged snapshotSeq as news (discovery-catalog
  // record), so the network picks it up within a gossip hop.
  mstream.post("/api/v1/admin/discovery/p2p/name", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      // Mirrors the config Joi (serverName): 64 chars, no pipe (the
      // announcement signing-string separator).
      name: Joi.string().min(1).max(64).pattern(/^[^|\p{Cc}]*$/u).required(),
    });
    joiValidate(schema, req.body);
    const name = req.body.name.trim();
    if (!name) { throw new WebError('name must not be blank', 400); }
    await admin.editDiscoveryServerName(name);
    let announced = false;
    try {
      if (discoveryExport.snapshotExists()) {
        await discoveryP2p.announceCurrentSnapshot();
        announced = true;
      }
    } catch (err) {
      winston.warn(`discovery name re-announce failed for admin '${req.user?.username}': ${err.message}`);
    }
    res.json({ announced });
  });

  // The operator-written catalog blurb (discoveryP2p.serverDescription) —
  // what users on other servers read to decide whether a DB is worth
  // downloading. Live: saves to config, then re-announces the current
  // snapshot (if one is published) so the network hears the edit now —
  // receivers treat a text change under an unchanged snapshotSeq as news
  // (see discovery-catalog.record). The 180-char/no-pipe/no-control rules
  // mirror the config Joi and the sidecar's own payload validation.
  mstream.post("/api/v1/admin/discovery/p2p/description", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      description: Joi.string().allow('').max(180).pattern(/^[^|\p{Cc}]*$/u).required(),
    });
    joiValidate(schema, req.body);
    await admin.editDiscoveryServerDescription(req.body.description.trim());
    // Best-effort broadcast: no snapshot yet / sidecar down just means
    // peers hear the new text with the next regular announce instead.
    let announced = false;
    try {
      if (discoveryExport.snapshotExists()) {
        await discoveryP2p.announceCurrentSnapshot();
        announced = true;
      }
    } catch (err) {
      winston.warn(`discovery description re-announce failed for admin '${req.user?.username}': ${err.message}`);
    }
    res.json({ announced });
  });

  // Join the catalog topic at runtime with an extra bootstrap peer (an
  // endpoint ticket or bare endpoint id — e.g. pasted from a friend's
  // Discovery page). Session-only by default; persist=true (what the UI's
  // befriend box sends) also appends it to config discoveryP2p.bootstrapPeers
  // — only after the sidecar accepted it, so a malformed ticket is never
  // saved.
  mstream.post("/api/v1/admin/discovery/p2p/join", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      peer: Joi.string().min(16).max(4096).required(),
      persist: Joi.boolean().default(false),
    });
    joiValidate(schema, req.body);
    try {
      discoveryCatalog.subscribe();
      const result = await discoveryP2p.join([req.body.peer]);
      if (req.body.persist === true) { await admin.editAddBootstrapPeer(req.body.peer); }
      res.json(result);
    } catch (err) {
      winston.warn(`discovery P2P join failed for admin '${req.user?.username}' (peer ${req.body.peer.slice(0, 32)}…): ${err.message}`);
      throw new WebError(`join failed: ${err.message}`, 500);
    }
  });

  // Seed the current export snapshot as a content-addressed blob. Returns
  // { hash, size, ticket } — hand the ticket to a peer and they can pull the
  // snapshot directly, BLAKE3-verified, relay-traversed. 404 until an export
  // has been built (the snapshot IS the shareable unit; we never publish the
  // live discovery.db).
  mstream.post("/api/v1/admin/discovery/p2p/publish", async (req, res) => {
    requireP2pEnabled();
    if (!discoveryExport.snapshotExists()) {
      throw new WebError('no discovery export has been built yet — build one first (POST /api/v1/admin/db/discovery-export)', 404);
    }
    try {
      res.json(await discoveryP2p.publish(discoveryExport.snapshotPath()));
    } catch (err) {
      winston.warn(`discovery P2P publish failed for admin '${req.user?.username}': ${err.message}`);
      throw new WebError(`publish failed: ${err.message}`, 500);
    }
  });

  // Pull a peer's snapshot into {dbDirectory}/discovery-peers/. Returns
  // { hash, size, path }; the transfer is BLAKE3-verified by the protocol,
  // so a completed fetch is an intact file. Addressing is EITHER a blob
  // ticket (manual hand-off, works with zero prior contact) OR the
  // endpointId of a catalog peer (the gossip flow — hash + provider come
  // from their latest signed announcement).
  mstream.post("/api/v1/admin/discovery/p2p/fetch", async (req, res) => {
    requireP2pEnabled();
    const schema = Joi.object({
      // BlobTickets are base32 strings; a generous cap guards the sidecar
      // from junk without rejecting legitimate multi-address tickets.
      ticket: Joi.string().min(16).max(4096),
      endpointId: Joi.string().hex().length(64),
    }).xor('ticket', 'endpointId');
    joiValidate(schema, req.body);

    let addressing;
    let label;
    let maxBytes;
    if (req.body.ticket) {
      // Ticket = a manual hand-off from someone the admin already trusts;
      // no announced size exists to bound it, so it stays uncapped.
      addressing = { ticket: req.body.ticket };
      label = `ticket ${req.body.ticket.slice(0, 32)}…`;
    } else {
      const entry = discoveryCatalog.get(req.body.endpointId);
      if (!entry) {
        throw new WebError('unknown peer — not in the catalog (no announcement heard from that endpointId)', 404);
      }
      addressing = { hash: entry.payload.hash, provider: entry.from };
      label = `peer ${req.body.endpointId.slice(0, 12)}…`;
      // The catalog flow rides the peer's own announcement, so hold the
      // transfer to the size it claimed — the same ceiling fetchPeer uses
      // (sidecars ≥ v1.0.4 abort past it; older ones ignore the param).
      maxBytes = entry.payload.size > 0 ? entry.payload.size : undefined;
    }

    const outDir = path.join(config.program.storage.dbDirectory, 'discovery-peers');
    try {
      // No hold: this raw route delivers a file, not a shelf membership —
      // nothing here would ever forget() the blob, so rooting it in the
      // sidecar store would pin those bytes forever. Un-held store copies
      // age out with GC; the exported file is the deliverable.
      res.json(await discoveryP2p.fetch(addressing, outDir, { maxBytes }));
    } catch (err) {
      winston.warn(`discovery P2P fetch failed for admin '${req.user?.username}' (${label}): ${err.message}`);
      throw new WebError(`fetch failed: ${err.message}`, 500);
    }
  });

  mstream.post("/api/v1/admin/db/params/auto-album-art", async (req, res) => {
    const schema = Joi.object({ autoAlbumArt: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAutoAlbumArt(req.body.autoAlbumArt);
    // Flipping the downloader ON enqueues an immediate pass so the user
    // sees results without waiting for the next scan — through the SAME
    // guarded path as the scan-drain trigger (skipImg, empty service
    // list, and anything-eligible checks all apply; the config flip
    // above already landed, so the guard's own autoAlbumArt check passes).
    if (req.body.autoAlbumArt === true) { dbQueue.maybeEnqueueAlbumArt(); }
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/auto-album-art-mode", async (req, res) => {
    const schema = Joi.object({
      autoAlbumArtMode: Joi.string().valid('missing', 'all').required()
    });
    joiValidate(schema, req.body);
    await admin.editAutoAlbumArtMode(req.body.autoAlbumArtMode);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/auto-album-art-write-to-folder", async (req, res) => {
    const schema = Joi.object({ autoAlbumArtWriteToFolder: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAutoAlbumArtWriteToFolder(req.body.autoAlbumArtWriteToFolder);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/auto-album-art-per-run", async (req, res) => {
    const schema = Joi.object({
      autoAlbumArtPerRun: Joi.number().integer().min(1).max(10000).required()
    });
    joiValidate(schema, req.body);
    await admin.editAutoAlbumArtPerRun(req.body.autoAlbumArtPerRun);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-write-to-folder", async (req, res) => {
    const schema = Joi.object({ albumArtWriteToFolder: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAlbumArtWriteToFolder(req.body.albumArtWriteToFolder);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-write-to-file", async (req, res) => {
    const schema = Joi.object({ albumArtWriteToFile: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAlbumArtWriteToFile(req.body.albumArtWriteToFile);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-art-services", async (req, res) => {
    const schema = Joi.object({
      albumArtServices: Joi.array().items(
        Joi.string().valid('musicbrainz', 'itunes', 'deezer')
      ).required()
    });
    joiValidate(schema, req.body);
    await admin.editAlbumArtServices(req.body.albumArtServices);
    res.json({});
  });

  // ── Lyrics backfill settings (config.lyrics; live, no reboot) ──
  mstream.get("/api/v1/admin/lyrics", (req, res) => {
    const cfg = config.program.lyrics || {};
    res.json({
      backfill:     !!cfg.backfill,
      providers:    Array.isArray(cfg.providers) ? cfg.providers : ['lrclib'],
      writeSidecar: !!cfg.writeSidecar,
      // Read-only counters over the lyrics_cache ledger the backfill worker
      // keeps (hit / miss / error / pending / other / total). Backs the
      // "Lyrics Cache" card in the Lyrics admin view.
      cache:        lyricsLrclib.cacheStats(),
    });
  });

  mstream.post("/api/v1/admin/lyrics/backfill", async (req, res) => {
    const schema = Joi.object({ backfill: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editLyricsBackfill(req.body.backfill);
    // Enabling kicks an immediate pass so the operator sees results without
    // waiting for the next scan — through the same guarded path as the
    // scan-drain trigger (dedup inside makes a double-toggle idempotent).
    if (req.body.backfill === true) { dbQueue.maybeEnqueueLyrics(); }
    res.json({});
  });

  mstream.post("/api/v1/admin/lyrics/providers", async (req, res) => {
    const schema = Joi.object({
      providers: Joi.array().items(
        Joi.string().valid('lrclib', 'netease', 'kugou')
      ).min(1).required()
    });
    joiValidate(schema, req.body);
    await admin.editLyricsProviders(req.body.providers);
    res.json({});
  });

  mstream.post("/api/v1/admin/lyrics/write-sidecar", async (req, res) => {
    const schema = Joi.object({ writeSidecar: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editLyricsWriteSidecar(req.body.writeSidecar);
    res.json({});
  });

  // Lyrics-cache ledger purge. Admin-only (guarded by the /admin/*
  // middleware). Two modes:
  //   - full  → drop every row (useful after a big tag-cleanup pass, so
  //             the backfill re-attempts everything)
  //   - retry → drop just 'error' + 'pending' rows (shakes loose a
  //             network-outage window without losing hits)
  const purgeLyricsCache = (req, res) => {
    // Match the Joi validation style the rest of /admin uses — a
    // malformed body (extra keys, wrong `mode` string) throws to the
    // global Joi handler (400) rather than silently proceeding with
    // defaults.
    const schema = Joi.object({
      mode: Joi.string().valid('full', 'retry').default('full'),
    });
    const { value } = joiValidate(schema, req.body || {});
    const removed = value.mode === 'retry'
      ? lyricsLrclib.purgeTransient()
      : lyricsLrclib.purgeAll();
    res.json({ removed, mode: value.mode });
  };
  mstream.post("/api/v1/admin/lyrics/cache/purge", purgeLyricsCache);

  mstream.get("/api/v1/admin/users", (req, res) => {
    const users = db.getAllUsers();
    const result = {};
    for (const user of users) {
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      result[user.username] = {
        admin: user.is_admin === 1,
        vpaths: libraries.map(l => l.name),
        allowMkdir: user.allow_mkdir === 1,
        allowUpload: user.allow_upload === 1,
        allowFileModify: user.allow_file_modify === 1,
        allowServerAudio: user.allow_server_audio === 1,
        // V37: whitelist flag for the optional torrent-client feature.
        // Only consulted by request handlers when
        // config.torrent.enabledFor === 'whitelist'; in 'all' mode this
        // is informational only.
        allowTorrent: user.allow_torrent === 1
      };
    }
    res.json(result);
  });

  mstream.put("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      // Anchored: the pattern was `/[a-zA-Z0-9-]+/` (unanchored), which
      // only requires the name to CONTAIN one slug char — a vpath like
      // `x"><img src=y onerror=...>` passed and later reached an
      // unescaped innerHTML/toast sink in the webapp. The admin UI's
      // input already enforces the anchored form; this closes the
      // direct-API bypass. vpaths are URL path segments, so slug-only.
      vpath: Joi.string().pattern(/^[a-zA-Z0-9-]+$/).required(),
      autoAccess: Joi.boolean().default(false),
      isAudioBooks: Joi.boolean().default(false),
      // Set at creation rather than via the follow-symlinks route so the
      // FIRST scan (queued right below) already honors it — a post-add
      // flag write races that scan and loses.
      followSymlinks: Joi.boolean().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addDirectory(
      input.value.directory,
      input.value.vpath,
      input.value.autoAccess,
      input.value.isAudioBooks,
      input.value.followSymlinks,
      mstream);
    res.json({});

    try {
      dbQueue.scanVPath(input.value.vpath);
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
    // Watched set tracks the library list (no-op while disabled).
    dbQueue.refreshLibraryWatchers();
  });

  mstream.delete("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required()
    });
    joiValidate(schema, req.body);

    await admin.removeDirectory(req.body.vpath);
    res.json({});
    dbQueue.refreshLibraryWatchers();
  });

  // V21: per-library followSymlinks flag. Takes effect on the next
  // scan of this library.
  mstream.post('/api/v1/admin/directory/follow-symlinks', async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      followSymlinks: Joi.boolean().required(),
    });
    const { value } = joiValidate(schema, req.body || {});
    await admin.setLibraryFollowSymlinks(value.vpath, value.followSymlinks);
    res.json({});
  });

  mstream.put("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      admin: Joi.boolean().optional().default(false),
      allowMkdir: Joi.boolean().optional().default(true),
      allowUpload: Joi.boolean().optional().default(true),
      // Server-audio access is opt-in per user — admins always bypass
      // the gate in server-playback.js, everyone else must be granted
      // explicitly via the admin panel.
      allowServerAudio: Joi.boolean().optional().default(false),
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths,
      input.value.allowMkdir,
      input.value.allowUpload,
      input.value.allowServerAudio
    );
    res.json({});
  });

  mstream.post("/api/v1/admin/db/force-compress-images", (req, res) => {
    res.json({ started: imageCompress.run() });
  });

  mstream.post("/api/v1/admin/db/scan/all", (req, res) => {
    dbQueue.scanAll();
    res.json({});
  });

  mstream.post("/api/v1/admin/db/scan/force-rescan", (req, res) => {
    dbQueue.rescanAll();
    res.json({});
  });

  mstream.get("/api/v1/admin/db/scan/stats", (req, res) => {
    const d = db.getDB();
    const row = d ? d.prepare('SELECT COUNT(*) AS total FROM tracks').get() : { total: 0 };
    res.json({ fileCount: row.total });
  });

  mstream.delete("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.deleteUser(req.body.username);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserPassword(req.body.username, req.body.password);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/lastfm", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      lastfmUser: Joi.string().required(),
      lastfmPassword: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setUserLastFM(req.body.username, req.body.lastfmUser, req.body.lastfmPassword);
    // Register the new creds with the in-process Scribble session map so the
    // user can scrobble without a server restart — the same warm /lastfm/connect
    // does. Without it the first post-set scrobble throws: Scribble.Scrobble
    // dereferences users[lastfmUser].sessionKey, and that entry only exists for
    // creds present when scrobbler.setup() pre-loaded the DB at boot.
    warmScrobbleUser(req.body.lastfmUser, req.body.lastfmPassword);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/vpaths", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required()
    });
    joiValidate(schema, req.body);

    await admin.editUserVPaths(req.body.username, req.body.vpaths);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/access", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      admin: Joi.boolean().required(),
      allowMkdir: Joi.boolean().required(),
      allowUpload: Joi.boolean().required(),
      allowFileModify: Joi.boolean().optional().default(true),
      // Opt-in per user. A PATCH that doesn't name allowServerAudio
      // leaves the user without access — clients that want to update
      // only one field must read the current value first and echo it.
      allowServerAudio: Joi.boolean().optional().default(false)
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(
      req.body.username,
      req.body.admin,
      req.body.allowMkdir,
      req.body.allowUpload,
      req.body.allowFileModify,
      req.body.allowServerAudio
    );
    res.json({});
  });

  mstream.get("/api/v1/admin/config", (req, res) => {
    res.json({
      address: config.program.address,
      port: config.program.port,
      noUpload: config.program.noUpload,
      noMkdir: config.program.noMkdir,
      noFileModify: config.program.noFileModify,
      writeLogs: config.program.writeLogs,
      logBufferSize: config.program.logBufferSize,
      secret: config.program.secret.slice(-4),
      ssl: config.program.ssl,
      storage: config.program.storage,
      maxRequestSize: config.program.maxRequestSize,
      downloadSizeLimit: config.program.downloadSizeLimit,
      autoBootServerAudio: config.program.autoBootServerAudio,
      rustPlayerPort: config.program.rustPlayerPort,
      dbSynchronous: config.program.db?.synchronous || 'FULL',
      dbCacheSizeMb: config.program.db?.cacheSizeMb || 64,
      compression: config.program.compression?.mode || 'none',
      ui: config.program.ui || 'default',
      adminAccess: config.program.adminAccess,
      trustProxy: config.program.trustProxy
    });
  });

  // SQLite synchronous mode for the main connection (FULL | NORMAL). Applied
  // live to the open connection — no reboot needed. See util/admin.editDbSynchronous.
  mstream.post("/api/v1/admin/config/db-synchronous", async (req, res) => {
    const schema = Joi.object({
      synchronous: Joi.string().valid('FULL', 'NORMAL').required()
    });
    joiValidate(schema, req.body);

    await admin.editDbSynchronous(req.body.synchronous);
    res.json({});
  });

  // SQLite page-cache size (MB) for the main connection. Applied live to the
  // open connection — no reboot. See util/admin.editDbCacheSize. The 1..2048
  // bound mirrors the Joi schema in src/state/config.js (dbOptions.cacheSizeMb).
  mstream.post("/api/v1/admin/config/db-cache-size", async (req, res) => {
    const schema = Joi.object({
      cacheSizeMb: Joi.number().integer().min(1).max(2048).required()
    });
    joiValidate(schema, req.body);

    await admin.editDbCacheSize(req.body.cacheSizeMb);
    res.json({});
  });

  // HTTP response-compression mode (none | gzip | brotli). Read live by the
  // compression middleware on every request — no reboot. See
  // util/admin.editCompression. Keep the valid() list in sync with the Joi
  // schema in src/state/config.js (compressionOptions.mode).
  mstream.post("/api/v1/admin/config/compression", async (req, res) => {
    const schema = Joi.object({
      mode: Joi.string().valid('none', 'gzip', 'brotli').required()
    });
    joiValidate(schema, req.body);

    await admin.editCompression(req.body.mode);
    res.json({});
  });

  // Admin-surface access control (mode = all | none | localhost | whitelist).
  // Read live by the IP gate (util/admin-network.js) + the lockAdmin-derived
  // guards on every request — no reboot. Keep the valid() list + the whitelist
  // IP validation in sync with the Joi schema in src/state/config.js
  // (adminAccessOptions). `whitelist` is optional: a mode-only change leaves
  // the configured list intact.
  mstream.post("/api/v1/admin/config/admin-access", async (req, res) => {
    const schema = Joi.object({
      mode: Joi.string().valid('all', 'none', 'localhost', 'whitelist').required(),
      whitelist: Joi.array().items(config.adminWhitelistEntry).optional()
    });
    joiValidate(schema, req.body);

    await admin.editAdminAccess({ mode: req.body.mode, whitelist: req.body.whitelist });
    res.json({});
  });

  mstream.post("/api/v1/admin/config/max-request-size", async (req, res) => {
    const schema = Joi.object({
      maxRequestSize: Joi.string().pattern(/[0-9]+(KB|MB)/i).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxRequestSize(req.body.maxRequestSize);
    res.json({});
  });

  // Cap on total bulk-download (zip) size. Size string: a whole/decimal number
  // + KB|MB|GB, or '0' for unlimited. Read live by the /api/v1/download/*
  // routes — no reboot. Keep the pattern in sync with state/config.js
  // `downloadSizeLimit`.
  mstream.post("/api/v1/admin/config/download-size-limit", async (req, res) => {
    const schema = Joi.object({
      downloadSizeLimit: Joi.string().pattern(/^(0|[0-9]+(\.[0-9]+)?(KB|MB|GB))$/i).required()
    });
    joiValidate(schema, req.body);

    await admin.editDownloadSizeLimit(req.body.downloadSizeLimit);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/ui", async (req, res) => {
    const schema = Joi.object({
      // Keep this list in sync with state/config.js `ui` validator.
      ui: Joi.string().valid('default', 'velvet').required()
    });
    joiValidate(schema, req.body);

    await admin.editUI(req.body.ui);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/port", async (req, res) => {
    const schema = Joi.object({
      port: Joi.number().required()
    });
    joiValidate(schema, req.body);

    await admin.editPort(req.body.port);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/address", async (req, res) => {
    const schema = Joi.object({
      address: Joi.string().ip({ cidr: 'forbidden' }).required(),
    });
    joiValidate(schema, req.body);

    await admin.editAddress(req.body.address);
    res.json({});
  });

  // Express' 'trust proxy' is set at boot, so changing the value triggers a
  // soft reboot (same as address/port). Posting the current value is a no-op.
  mstream.post("/api/v1/admin/config/trust-proxy", async (req, res) => {
    const schema = Joi.object({
      trustProxy: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editTrustProxy(req.body.trustProxy);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/noupload", async (req, res) => {
    const schema = Joi.object({
      noUpload: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUpload(req.body.noUpload);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/nomkdir", async (req, res) => {
    const schema = Joi.object({
      noMkdir: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editMkdir(req.body.noMkdir);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/nofilemodify", async (req, res) => {
    const schema = Joi.object({
      noFileModify: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editFileModify(req.body.noFileModify);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/write-logs", async (req, res) => {
    const schema = Joi.object({
      writeLogs: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editWriteLogs(req.body.writeLogs);
    res.json({});
  });

  // Keep the bounds in sync with the logBufferSize validator in
  // state/config.js (0 = disabled, 10000 = hard cap).
  mstream.post("/api/v1/admin/config/log-buffer-size", async (req, res) => {
    const schema = Joi.object({
      logBufferSize: Joi.number().integer().min(0).max(10000).required()
    });
    joiValidate(schema, req.body);

    await admin.editLogBufferSize(req.body.logBufferSize);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/auto-boot-server-audio", async (req, res) => {
    const schema = Joi.object({
      autoBootServerAudio: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAutoBootServerAudio(req.body.autoBootServerAudio);

    // Flag controls Rust preference now. Either way, re-boot server audio so
    // the active backend matches the new setting:
    //   true  → kill current backend, boot Rust (with CLI fallback)
    //   false → kill current backend, boot CLI directly (MPD preferred)
    killRustPlayer();
    await bootRustPlayer();

    res.json({});
  });

  mstream.post("/api/v1/admin/config/rust-player-port", async (req, res) => {
    const schema = Joi.object({
      rustPlayerPort: Joi.number().integer().min(1).max(65535).required()
    });
    joiValidate(schema, req.body);

    await admin.editRustPlayerPort(req.body.rustPlayerPort);
    res.json({});
  });

  mstream.get("/api/v1/admin/server-audio/info", (req, res) => {
    const active = getActiveBackend();
    res.json({
      backend: active.backend,
      player: active.player,
      detectedCliPlayers: getDetectedCliPlayers(),
      // Whether a missing player binary could be fetched for this platform
      // (npm/source installs download it on first autoBoot; musl hosts
      // have no build and report false).
      binaryFetchable: playerBinaryFetchable(),
    });
  });

  // Re-run the CLI player detection probe. Use this after installing or
  // removing a player (mpv, vlc, mplayer, or an MPD daemon) without having
  // to restart the server.
  mstream.post("/api/v1/admin/server-audio/detect", async (req, res) => {
    const detected = await refreshDetectedCliPlayers();
    res.json({ detectedCliPlayers: detected });
  });

  mstream.post("/api/v1/admin/config/secret", async (req, res) => {
    const schema = Joi.object({
      strength: Joi.number().integer().positive().required()
    });
    joiValidate(schema, req.body);

    const secret = await config.asyncRandom(req.body.strength);
    await admin.editSecret(secret);
    res.json({});
  });

  mstream.get("/api/v1/admin/transcode", (req, res) => {
    const memClone = JSON.parse(JSON.stringify(config.program.transcode));
    memClone.downloaded = transcode.isDownloaded();
    res.json(memClone);
  });

  mstream.post("/api/v1/admin/transcode/default-codec", async (req, res) => {
    const schema = Joi.object({
      defaultCodec: Joi.string().valid(...getTransCodecs()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultCodec(req.body.defaultCodec);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-bitrate", async (req, res) => {
    const schema = Joi.object({
      defaultBitrate: Joi.string().valid(...getTransBitrates()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultBitrate(req.body.defaultBitrate);
    res.json({});
  });

  // default-algorithm endpoint removed — streaming is now the only mode

  mstream.post("/api/v1/admin/transcode/auto-update", async (req, res) => {
    const schema = Joi.object({
      autoUpdate: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editAutoUpdate(req.body.autoUpdate);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
  });

  // ── Release updates (util/update-check.js) ──────────────────────────────
  // Status is in-memory state, instant; check hits the release feed and
  // waits; download kicks staging off and returns - a bundle is minutes on
  // a slow link, so the card polls GET status instead of hanging a POST.

  mstream.get("/api/v1/admin/update", (req, res) => {
    res.json(updateCheck.getStatus());
  });

  mstream.post("/api/v1/admin/update/check", async (req, res) => {
    res.json(await updateCheck.checkNow(true));
  });

  mstream.post("/api/v1/admin/update/download", (req, res) => {
    const r = updateCheck.stageNow();
    if (r.error) { return res.status(409).json(r); }
    res.json(r);
  });

  mstream.post("/api/v1/admin/update/apply", async (req, res) => {
    const r = await updateCheck.requestApply();
    if (r.error) { return res.status(409).json(r); }
    res.json(r);
  });

  mstream.post("/api/v1/admin/update/settings", async (req, res) => {
    const schema = Joi.object({
      check: Joi.boolean(),
      mode: Joi.string().valid('notify', 'stage', 'auto'),
      skipVersion: Joi.string().pattern(/^\d+\.\d+\.\d+$/).allow(''),
      // Operator override for boot-failure holds (the launcher's watchdog
      // rolled an update back): drop them all and let the next check retry.
      clearHold: Joi.boolean(),
    }).or('check', 'mode', 'skipVersion', 'clearHold');
    joiValidate(schema, req.body);

    if (req.body.check !== undefined) { await admin.editUpdatesCheck(req.body.check); }
    if (req.body.mode !== undefined) { await admin.editUpdatesMode(req.body.mode); }
    if (req.body.skipVersion !== undefined) { await admin.editUpdatesSkipVersion(req.body.skipVersion); }
    if (req.body.clearHold === true) { await updateCheck.clearHolds(); }
    updateCheck.onSettingsChanged();
    res.json({});
  });

  // Live-log viewer feed. Returns recent entries from the in-memory ring
  // buffer (logger.js) so the admin panel can poll a tail without touching
  // disk — works even when writeLogs is off. `since` is the highest seq the
  // client already has; the server returns newer entries plus the current
  // `lastSeq` cursor and the buffer `capacity`.
  mstream.get("/api/v1/admin/logs/recent", (req, res) => {
    res.json(logger.getRecentLogs(req.query.since));
  });

  mstream.get("/api/v1/admin/logs/download", (req, res) => {
    const archive = new ZipArchive();
    archive.on('error', err => {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`mstream-logs.zip`);

    //streaming magic
    archive.pipe(res);
    archive.directory(config.program.storage.logsDirectory, false)
    archive.finalize();
  });

  mstream.get("/api/v1/admin/db/shared", (req, res) => {
    const d = db.getDB();
    // Reshape raw rows into the shape both admin UIs read: playlistId /
    // user / expires (see webapp/admin/index.js + webapp/velvet/admin).
    // The LokiJS→SQLite migration renamed the columns (share_id,
    // user_id, playlist_json) but this list endpoint kept its
    // pre-migration `SELECT *`, so the UI bound to fields that no longer
    // existed — blank ids, blank user, and a per-row delete that posted
    // `undefined` as the id. LEFT JOIN users so an orphaned share
    // (user_id SET NULL when its owner is deleted) still lists, with
    // user = null.
    //
    // The playlist blobs themselves never leave the DB: the admin UIs
    // render id/user/expires and a per-row delete, nothing else, yet this
    // endpoint used to fetch + JSON.parse + re-stringify EVERY share's
    // full track list — and blob volume is controlled by NON-admin users
    // (2026-07 audit M3: ~1 s and a 64 MB response at 200 shares × 5k
    // tracks). json_array_length gives the UI a track count for the cost
    // of reading the header; json_valid guards it (a corrupt blob would
    // otherwise fail the whole statement, and corrupt shares must stay
    // listable so the admin can delete them).
    const rows = d.prepare(`
      SELECT s.share_id, s.expires, s.created_at, u.username,
             CASE WHEN json_valid(s.playlist_json)
                  THEN json_array_length(s.playlist_json) ELSE 0 END AS track_count
      FROM shared_playlists s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.id DESC
    `).all();

    res.json(rows.map(r => ({
      playlistId: r.share_id,
      user: r.username,
      trackCount: r.track_count,
      expires: r.expires,
      created: r.created_at,
    })));
  });

  mstream.delete("/api/v1/admin/db/shared", (req, res) => {
    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    db.getDB().prepare('DELETE FROM shared_playlists WHERE share_id = ?').run(req.body.id);
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/expired", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    db.getDB().prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(now);
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/eternal", (req, res) => {
    db.getDB().prepare('DELETE FROM shared_playlists WHERE expires IS NULL').run();
    res.json({});
  });

  mstream.delete("/api/v1/admin/ssl", async (req, res) => {
    // DELETE on a cert that isn't configured — there's nothing to remove.
    // `ssl` is optional config, so guard the access too (it was an unguarded
    // `.ssl.cert` that TypeError'd → 500 when ssl was absent entirely).
    if (!config.program.ssl?.cert) { throw new WebError('No Certs', 404); }
    await admin.removeSSL();
    res.json({});
  });

  mstream.get('/api/v1/admin/dlna', (req, res) => {
    res.json({
      mode:   config.program.dlna.mode,
      port:   config.program.dlna.port,
      name:   config.program.dlna.name,
      uuid:   config.program.dlna.uuid,
      browse: config.program.dlna.browse,
    });
  });

  mstream.post('/api/v1/admin/dlna/browse', async (req, res) => {
    const schema = Joi.object({
      browse: Joi.string().valid('flat', 'dirs', 'artist', 'album', 'genre').required(),
    });
    const input = joiValidate(schema, req.body);
    await admin.editDlnaBrowse(input.value.browse);
    res.json({});
  });

  // DLNA friendly name shown to renderers. Re-announces over SSDP when DLNA
  // is active so clients re-read the description; no reboot.
  mstream.post('/api/v1/admin/dlna/name', async (req, res) => {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(256).required(),
    });
    const input = joiValidate(schema, req.body);
    await admin.editDlnaName(input.value.name);
    res.json({});
  });

  // DLNA device UUID. Must be a canonical GUID — the value feeds SSDP USN
  // strings (`uuid:<id>::urn:...`) verbatim, so a malformed value would
  // corrupt discovery. The helper byebyes the old identity before announcing
  // the new one.
  mstream.post('/api/v1/admin/dlna/uuid', async (req, res) => {
    const schema = Joi.object({
      uuid: Joi.string().guid().required(),
    });
    const input = joiValidate(schema, req.body);
    await admin.editDlnaUuid(input.value.uuid);
    res.json({});
  });

  let dlnaDebouncer = false;
  mstream.post('/api/v1/admin/dlna/mode', async (req, res) => {
    const schema = Joi.object({
      mode: Joi.string().valid('disabled', 'same-port', 'separate-port').required(),
      port: Joi.number().integer().min(1).max(65535).optional(),
    });
    const input = joiValidate(schema, req.body);

    if (dlnaDebouncer === true) { throw new Error('Debouncer Enabled'); }
    await admin.enableDlna(input.value.mode, input.value.port);

    dlnaDebouncer = true;
    setTimeout(() => { dlnaDebouncer = false; }, 2000);

    res.json({});
  });

  // All torrent admin endpoints live in admin-torrent.js — registered
  // inside the same admin-guard scope as everything else in this
  // file, so they inherit the lockAdmin / admin-only checks at the
  // top of this function.
  adminTorrent.register(mstream);
  adminFederation.register(mstream);


  mstream.post("/api/v1/admin/ssl", async (req, res) => {
    const schema = Joi.object({
      cert: Joi.string().required(),
      key: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setSSL(path.resolve(req.body.cert), path.resolve(req.body.key));
    res.json({});
  });
}
