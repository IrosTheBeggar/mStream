import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import * as auth from './auth.js';
import * as config from '../state/config.js';
import * as mStreamServer from '../server.js';
import * as dbQueue from '../db/task-queue.js';
import * as logger from '../logger.js';
import * as db from '../db/manager.js';
import { cleanupOrphans } from '../db/orphan-cleanup.js';
import * as vpathAccessCache from '../torrent/vpath-access-cache.js';
import * as managedTorrents from '../torrent/managed-torrents.js';
import { sweepVpathsForActiveClient } from '../torrent/vpath-sweep.js';
import winston from 'winston';
// syncthing import disabled — federation feature is being rebuilt
// around the local-backup story (see src/server.js). Restore this
// import when re-enabling enableFederation() below.
// import * as syncthing from '../state/syncthing.js';
import * as dlnaSsdp from '../dlna/ssdp.js';
import * as dlnaServer from '../dlna/dlna-server.js';
import * as subsonicServer from '../subsonic/subsonic-server.js';
import { getDirname } from './esm-helpers.js';
import { launchWorker } from './worker-process.js';
import { invalidateWhitelistCache } from './admin-network.js';

const __dirname = getDirname(import.meta.url);

// ── Config file helpers (for server-level settings) ─────────────────────────

export async function loadFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export function saveFile(saveData, file) {
  return fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8');
}

// ── Directory / Library management (now in SQLite) ──────────────────────────

export async function addDirectory(directory, vpath, autoAccess, isAudioBooks, mstream) {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw new Error(`${directory} is not a directory`); }

  const existing = db.getLibraryByName(vpath);
  if (existing) { throw new Error(`'${vpath}' already exists`); }

  const d = db.getDB();
  const type = isAudioBooks ? 'audio-books' : 'music';
  // follow_symlinks is explicitly set to 0 here rather than relying
  // on the column default: dev hosts that ran an earlier V21 variant
  // (nullable column, no DEFAULT) would otherwise get NULL on new
  // INSERTs. Reader code in task-queue.js is null-safe (`=== 1`) but
  // we'd rather not leave dangling NULLs in the table.
  const result = d.prepare(
    'INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)'
  ).run(vpath, directory, type);
  const libraryId = Number(result.lastInsertRowid);

  if (autoAccess === true) {
    const users = db.getAllUsers();
    const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
    for (const user of users) {
      insertUL.run(user.id, libraryId);
    }
  }

  db.invalidateCache();

  // Add to express routing
  mstream.use(`/media/${vpath}/`, express.static(directory));

  // Kick off a torrent-client vpath-access probe for the new library
  // in the background. Awaiting would make addDirectory block on a
  // daemon round-trip (potentially 30s+ if the daemon is slow or
  // unreachable), and a daemon-down case must not fail the library-
  // add — those are independent features. The sweep itself is a
  // no-op when no torrent client is active, so this is safe to call
  // unconditionally. We pull the library row back from the cache
  // because the sweep wants a hydrated lib object, not the raw inputs.
  const newLib = db.getLibraryByName(vpath);
  if (newLib) {
    sweepVpathsForActiveClient([newLib]).catch(err => {
      // Sweep already swallows per-vpath errors into the cache row's
      // verification reason. Any throw that reaches here is an
      // unexpected programming error in the sweep itself — log but
      // don't surface to the admin, who already got their 200.
      winston.warn(`[torrent] background vpath probe failed for '${vpath}': ${err.message}`);
    });
  }
}

/**
 * Set the per-library followSymlinks flag.
 *
 *   followSymlinks === true   → scanner follows symlinks in this library
 *   followSymlinks === false  → scanner skips symlink entries (default)
 *
 * Takes effect on the next scan of this library. Does NOT trigger
 * a rescan on its own — the operator should click "Rescan" manually
 * if they want existing tracks re-evaluated under the new rule.
 * (Running an auto-rescan would be surprising for libraries that
 * don't actually contain any symlinks.)
 */
export async function setLibraryFollowSymlinks(vpath, followSymlinks) {
  const library = db.getLibraryByName(vpath);
  if (!library) { throw new Error(`'${vpath}' not found`); }
  db.getDB().prepare(
    'UPDATE libraries SET follow_symlinks = ? WHERE id = ?'
  ).run(followSymlinks ? 1 : 0, library.id);
  db.invalidateCache();
}

export async function removeDirectory(vpath) {
  const library = db.getLibraryByName(vpath);
  if (!library) { throw new Error(`'${vpath}' not found`); }

  const d = db.getDB();
  // CASCADE will delete tracks and user_libraries entries
  d.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);

  // Clean up orphan albums / artists / genres left over after the
  // tracks cascade. Chunked + commits per chunk so the multi-second
  // 4-way NOT IN on artists doesn't bust busy_timeout for concurrent
  // API writes — see src/db/orphan-cleanup.js for the design notes.
  // Worse here than in the scanner because this runs INSIDE the main
  // Node process — a multi-second sync DELETE would block every other
  // request handler too.
  cleanupOrphans(d);

  // Drop the per-(client, vpath) path-mapping cache rows so an admin
  // who deleted this library because its mapping was wrong doesn't
  // see stale rows for it after a re-add. The cache table has no FK
  // to libraries (vpath_name is matched by string), so the cascade
  // wouldn't catch this on its own.
  //
  // Done after the cascade so a failure here doesn't strand a
  // partially-deleted library; the worst case is leftover cache rows
  // that get overwritten on next probe of a same-named re-added vpath.
  try { vpathAccessCache.deleteByVpath(vpath); }
  catch (_err) { /* cache is advisory; never block library delete on it */ }

  // Drop managed_torrents rows tied to this vpath. Same TEXT-not-FK
  // story as the access cache — the rows would otherwise stick
  // around with a dangling vpath name and the admin list would
  // demote them to "external" badges on the next refresh.
  try {
    const dropped = managedTorrents.deleteByVpath(vpath);
    if (dropped > 0) {
      winston.info(`[admin] removeDirectory '${vpath}': dropped ${dropped} managed_torrents row(s) (daemon-side torrents untouched)`);
    }
  } catch (err) {
    winston.warn(`[admin] removeDirectory '${vpath}': managed_torrents cleanup failed: ${err.message}`);
  }

  db.invalidateCache();

  // Reboot to remove the static route
  mStreamServer.reboot();
}

// ── User management (now in SQLite) ─────────────────────────────────────────

export async function addUser(username, password, admin, vpaths, allowMkdir, allowUpload, allowServerAudio = false) {
  const existing = db.getUserByUsername(username);
  if (existing) { throw new Error(`'${username}' already exists`); }

  const hash = await auth.hashPassword(password);
  const d = db.getDB();

  const result = d.prepare(
    `INSERT INTO users (username, password, salt, is_admin, allow_upload, allow_mkdir, allow_server_audio)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(username, hash.hashPassword, hash.salt, admin ? 1 : 0, allowUpload ? 1 : 0, allowMkdir ? 1 : 0, allowServerAudio ? 1 : 0);

  const userId = Number(result.lastInsertRowid);

  // Link vpaths
  if (vpaths && vpaths.length > 0) {
    const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
    for (const vpathName of vpaths) {
      const lib = db.getLibraryByName(vpathName);
      if (lib) { insertUL.run(userId, lib.id); }
    }
  }

  db.invalidateCache();
}

export async function deleteUser(username) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const d = db.getDB();
  // CASCADE will delete user_metadata, playlists, playlist_tracks, user_libraries
  d.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  db.invalidateCache();
}

export async function editUserPassword(username, password) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const hash = await auth.hashPassword(password);
  db.getDB().prepare(
    'UPDATE users SET password = ?, salt = ? WHERE id = ?'
  ).run(hash.hashPassword, hash.salt, user.id);

  db.invalidateCache();
}

export async function editUserVPaths(username, vpaths) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const d = db.getDB();
  // Clear existing and re-add
  d.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(user.id);
  const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
  for (const vpathName of vpaths) {
    const lib = db.getLibraryByName(vpathName);
    if (lib) { insertUL.run(user.id, lib.id); }
  }

  db.invalidateCache();
}

export async function editUserAccess(username, admin, allowMkdir, allowUpload, allowFileModify = true, allowServerAudio = false) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  db.getDB().prepare(
    'UPDATE users SET is_admin = ?, allow_mkdir = ?, allow_upload = ?, allow_file_modify = ?, allow_server_audio = ? WHERE id = ?'
  ).run(admin ? 1 : 0, allowMkdir ? 1 : 0, allowUpload ? 1 : 0, allowFileModify ? 1 : 0, allowServerAudio ? 1 : 0, user.id);

  db.invalidateCache();
}

// Set or clear the V35 opt-in Subsonic-specific password. Pass null/empty
// to clear (revert the user to no token-auth, friendly error message
// at /rest/* time). Used by both the admin endpoint and (by way of
// the user-side endpoint) by users managing their own.
//
// Imports the encrypt helper lazily — the helper depends on
// config.program.subsonicSecret which isn't populated until config.setup
// runs, and admin.js is imported much earlier in the boot path.
export async function setSubsonicPassword(username, plaintext) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const d = db.getDB();
  if (plaintext == null || plaintext === '') {
    d.prepare('UPDATE users SET subsonic_password_encrypted = NULL WHERE id = ?').run(user.id);
  } else {
    const { encryptSubsonicPassword } = await import('./subsonic-password.js');
    const encrypted = encryptSubsonicPassword(plaintext);
    d.prepare('UPDATE users SET subsonic_password_encrypted = ? WHERE id = ?').run(encrypted, user.id);
  }
  db.invalidateCache();
}

// Set a user's stored Last.fm credentials — the V1 lastfm_user/lastfm_password
// columns that live directly on the users row. Same lookup-then-UPDATE shape as
// editUserPassword, and the same storage write the self-service /lastfm/connect
// endpoint (velvet-stubs.js) uses. Registering the creds with the in-process
// Scribble session map (warmScrobbleUser) is the route handler's job — that
// singleton lives in the api layer, so util/ stays out of it.
export async function setUserLastFM(username, lastfmUser, lastfmPassword) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  db.getDB().prepare(
    'UPDATE users SET lastfm_user = ?, lastfm_password = ? WHERE id = ?'
  ).run(lastfmUser, lastfmPassword, user.id);

  db.invalidateCache();
}

// ── Config file settings (server-level, stay in JSON) ───────────────────────

export async function editUI(ui) {
  if (config.program.ui === ui) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ui = ui;
  // When switching TO ui='subsonic', auto-enable Subsonic same-port if
  // it's currently disabled / separate-port. The bundled Refix SPA
  // only works with same-port (its env.js SERVER_URL="" resolves to
  // the current origin). Leaving the admin to manually fix subsonic
  // mode after a UI switch produces a broken client with a silent
  // failure mode — they see Refix's "couldn't reach server" error
  // with no guidance. Flip it for them and log.
  if (ui === 'subsonic') {
    if (!loadConfig.subsonic) { loadConfig.subsonic = {}; }
    if (loadConfig.subsonic.mode !== 'same-port') {
      loadConfig.subsonic.mode = 'same-port';
    }
  }
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editPort(port) {
  if (config.program.port === port) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.port = port;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editMaxRequestSize(maxRequestSize) {
  if (config.program.maxRequestSize === maxRequestSize) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.maxRequestSize = maxRequestSize;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

// Cap on bulk-download (zip) size (size string, '0' = unlimited). The
// /api/v1/download/* routes read config.program.downloadSizeLimit fresh on
// each request, so no reboot — persist to config and mutate the in-memory
// value so the next download observes it.
export async function editDownloadSizeLimit(val) {
  if (config.program.downloadSizeLimit === val) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.downloadSizeLimit = val;
  await saveFile(loadConfig, config.configFile);
  config.program.downloadSizeLimit = val;
}

export async function editUpload(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noUpload = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noUpload = val;
}

export async function editMkdir(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noMkdir = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noMkdir = val;
}

export async function editFileModify(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noFileModify = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noFileModify = val;
}

export async function editAddress(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.address = val;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

// trustProxy is consumed once at boot (server.js sets Express' 'trust proxy'
// before any routes mount), so flipping it requires the soft reboot — just
// mutating config.program wouldn't affect the running app. No-op when the
// value is unchanged so a redundant POST doesn't bounce the server.
export async function editTrustProxy(val) {
  if (config.program.trustProxy === val) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.trustProxy = val;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editSecret(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.secret = val;
  await saveFile(loadConfig, config.configFile);
  config.program.secret = val;
}

export async function editScanInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanInterval = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.scanInterval = val;
  dbQueue.resetScanInterval();
}

export async function editSkipImg(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.skipImg = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.skipImg = val;
}

export async function editBootScanDelay(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanDelay = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.bootScanDelay = val;
}

export async function editCompressImages(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.compressImage = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.compressImage = val;
}

export async function editScanCommitInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanCommitInterval = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.scanCommitInterval = val;
}

export async function editScanThreads(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanThreads = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.scanThreads = val;
}

export async function editGenerateWaveforms(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.generateWaveforms = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.generateWaveforms = val;
}

// essentia BPM + musical-key analysis toggle. Mirrors the
// generateWaveforms pattern above: persist to config.json on disk
// so the new value survives restart, then mutate config.program
// in-memory so the post-scan audio-analysis pass (gated on this flag
// in task-queue.js) and its run-time re-check pick up the change
// without waiting for a process restart. The api route enqueues an
// immediate pass when this flips on.
export async function editAnalyzeBpm(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.analyzeBpm = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.analyzeBpm = val;
}

// Tracks analysed per essentia pass. Same live-update pattern as
// editAutoAlbumArtPerRun — the worker reads it fresh when task-queue builds
// the pass's jsonLoad, so a change takes effect on the next pass with no reboot.
export async function editAnalyzeBpmPerRun(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.analyzeBpmPerRun = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.analyzeBpmPerRun = val;
}

// Music-discovery data collection toggle (the separate discovery.db —
// src/db/discovery-db.js). Same live-update pattern as editAnalyzeBpm:
// persist to config.json, then mutate config.program in-memory so no reboot
// is needed. The api route initializes the discovery DB when this flips on;
// flipping it off stops future collection but keeps the existing data
// (deleting {dbDirectory}/discovery.db is the operator's explicit purge).
export async function editCollectDiscoveryData(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.collectDiscoveryData = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.collectDiscoveryData = val;
}

export async function editAutoAlbumArt(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArt = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArt = val;
}

export async function editAutoAlbumArtMode(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArtMode = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArtMode = val;
}

export async function editAutoAlbumArtWriteToFolder(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArtWriteToFolder = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArtWriteToFolder = val;
}

export async function editAutoAlbumArtPerRun(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArtPerRun = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArtPerRun = val;
}

export async function editAlbumArtWriteToFolder(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtWriteToFolder = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtWriteToFolder = val;
}

export async function editAlbumArtWriteToFile(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtWriteToFile = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtWriteToFile = val;
}

export async function editAlbumArtServices(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtServices = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtServices = val;
}

// Lyrics backfill knobs live under config.lyrics (not scanOptions).
// Both are LIVE — the backfill worker reads them fresh per pass, so no
// reboot is needed.
export async function editLyricsBackfill(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.lyrics) { loadConfig.lyrics = {}; }
  loadConfig.lyrics.backfill = val;
  await saveFile(loadConfig, config.configFile);
  if (!config.program.lyrics) { config.program.lyrics = {}; }
  config.program.lyrics.backfill = val;
}

export async function editLyricsProviders(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.lyrics) { loadConfig.lyrics = {}; }
  loadConfig.lyrics.providers = val;
  await saveFile(loadConfig, config.configFile);
  if (!config.program.lyrics) { config.program.lyrics = {}; }
  config.program.lyrics.providers = val;
}

export async function editLyricsWriteSidecar(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.lyrics) { loadConfig.lyrics = {}; }
  loadConfig.lyrics.writeSidecar = val;
  await saveFile(loadConfig, config.configFile);
  if (!config.program.lyrics) { config.program.lyrics = {}; }
  config.program.lyrics.writeSidecar = val;
}

export async function editWriteLogs(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await saveFile(loadConfig, config.configFile);
  config.program.writeLogs = val;
  if (val === false) { logger.reset(); }
  else { logger.addFileLogger(config.program.storage.logsDirectory); }
}

// Resize the in-memory live-log ring buffer that backs the admin panel's
// live-log viewer. Persisted to config.json so it survives restart, then
// applied to the running logger immediately — no reboot needed (the buffer
// keeps its most recent entries that still fit under the new capacity).
export async function editLogBufferSize(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.logBufferSize = val;
  await saveFile(loadConfig, config.configFile);
  config.program.logBufferSize = val;
  logger.setBufferCapacity(val);
}

export async function editDefaultCodec(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultCodec = val;
  await saveFile(loadConfig, config.configFile);
  config.program.transcode.defaultCodec = val;
}

export async function editDefaultBitrate(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultBitrate = val;
  await saveFile(loadConfig, config.configFile);
  config.program.transcode.defaultBitrate = val;
}

// Toggle weekly auto-update of the managed ffmpeg build. Persisted to the
// config file and reflected in the running config immediately — the bootstrap
// reads config.program.transcode.autoUpdate at each check, so no reboot needed.
export async function editAutoUpdate(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.autoUpdate = val;
  await saveFile(loadConfig, config.configFile);
  config.program.transcode.autoUpdate = val;
}

// Set the SQLite synchronous mode for the main DB connection (FULL | NORMAL).
// Persisted to config and applied to the live connection immediately —
// PRAGMA synchronous is per-connection and takes effect on the next
// transaction, so no reboot is needed.
export async function editDbSynchronous(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.db) { loadConfig.db = {}; }
  loadConfig.db.synchronous = val;
  await saveFile(loadConfig, config.configFile);
  config.program.db.synchronous = val;
  db.setSynchronous(val);
}

// Set the SQLite page-cache size (MB) for the main DB connection. Persisted to
// config and applied to the live connection immediately — PRAGMA cache_size is
// per-connection and governs subsequent queries, so no reboot is needed.
export async function editDbCacheSize(mb) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.db) { loadConfig.db = {}; }
  loadConfig.db.cacheSizeMb = mb;
  await saveFile(loadConfig, config.configFile);
  config.program.db.cacheSizeMb = mb;
  db.setCacheSize(mb);
}

// Set the HTTP response-compression mode (none | gzip | brotli). Persisted to
// config; no reboot needed because the compression middleware reads
// config.program.compression.mode fresh on every request, so the change takes
// effect on the next response.
export async function editCompression(mode) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.compression) { loadConfig.compression = {}; }
  loadConfig.compression.mode = mode;
  await saveFile(loadConfig, config.configFile);
  if (!config.program.compression) { config.program.compression = {}; }
  config.program.compression.mode = mode;
}

// Persist the admin-access security setting (mode + optional whitelist).
// Mirrors the other live-read editX helpers: write to config.json, then
// mutate config.program in-memory so the gate (util/admin-network.js) and
// the lockAdmin-derived guards observe the change on the next request — no
// reboot, all four modes are live middleware reads. We also re-derive the
// legacy lockAdmin flag (mode==='none') here so the historical readers stay
// in sync, and invalidate the network module's cached BlockList so a new
// whitelist takes effect immediately.
//
// `whitelist` is optional: when omitted we leave the persisted/in-memory
// whitelist untouched (a mode-only change shouldn't wipe a configured list).
export async function editAdminAccess({ mode, whitelist }) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.adminAccess) { loadConfig.adminAccess = {}; }
  loadConfig.adminAccess.mode = mode;
  if (whitelist !== undefined) { loadConfig.adminAccess.whitelist = whitelist; }
  // Keep the persisted legacy flag consistent with the mode so the on-disk
  // config never shows a contradictory lockAdmin alongside adminAccess.mode
  // (the in-memory derive below is what actually drives behavior).
  loadConfig.lockAdmin = (mode === 'none');
  await saveFile(loadConfig, config.configFile);

  if (!config.program.adminAccess) { config.program.adminAccess = {}; }
  config.program.adminAccess.mode = mode;
  if (whitelist !== undefined) { config.program.adminAccess.whitelist = whitelist; }
  // Keep the derived legacy flag in lockstep — every reader of lockAdmin
  // (auth.js, server.js, admin.js, federation.js) depends on this.
  config.program.lockAdmin = (mode === 'none');
  // The whitelist BlockList is cached in admin-network.js; rebuild it.
  invalidateWhitelistCache();
}

// Legacy lock-api toggle, preserved for the velvet admin UI's existing
// POST /api/v1/admin/lock-api endpoint. A thin shim over the richer
// adminAccess setting. lock=true always fully disables (mode='none'). lock=false
// (unlock) only relaxes to 'all' when currently fully locked — if the operator
// has configured a richer mode ('localhost'/'whitelist'), a boolean unlock must
// NOT silently strip their IP gate, since the boolean can't represent it.
export async function lockAdminApi(val) {
  if (val) {
    await editAdminAccess({ mode: 'none' });
    return;
  }
  if (config.program.adminAccess?.mode === 'none') {
    await editAdminAccess({ mode: 'all' });
  }
}

export async function editDlnaBrowse(browse) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.browse = browse;
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.browse = browse;
}

// DLNA friendly name. It's read live by the device-description XML
// (src/api/dlna.js) and the root-container title, so no reboot is needed —
// but renderers cache the description from discovery time, so when DLNA is
// active we re-announce (SSDP byebye + alive under the SAME uuid) to nudge
// them into re-fetching it. No SSDP socket runs when mode === 'disabled', so
// we just persist in that case.
export async function editDlnaName(name) {
  if (config.program.dlna.name === name) { return; }
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.name = name;
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.name = name;
  if (config.program.dlna.mode !== 'disabled') {
    dlnaSsdp.stop();
    dlnaSsdp.start();
  }
}

// DLNA device UUID — the identity every renderer keys its device list on.
// Changing it while DLNA is active needs care: the byebye for the OLD uuid
// must go out BEFORE we overwrite it, or renderers keep the stale device
// until its cache expires and the new uuid shows up as a duplicate.
// ssdp.stop() snapshots the current uuid synchronously when it builds the
// byebye batch, so stop() → mutate → start() sends byebye(old)+alive(new).
export async function editDlnaUuid(uuid) {
  if (config.program.dlna.uuid === uuid) { return; }
  const active = config.program.dlna.mode !== 'disabled';
  if (active) { dlnaSsdp.stop(); } // byebye under the OLD uuid
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.uuid = uuid;
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.uuid = uuid;
  if (active) { dlnaSsdp.start(); } // alive under the NEW uuid
}

export async function enableDlna(mode, port) {
  const effectivePort = port !== undefined ? port : config.program.dlna.port;
  if (mode === config.program.dlna.mode && effectivePort === config.program.dlna.port) { return; }

  const prevMode = config.program.dlna.mode;

  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.mode = mode;
  if (port !== undefined) { loadConfig.dlna.port = port; }
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.mode = mode;
  if (port !== undefined) { config.program.dlna.port = port; }

  // same-port registers routes on the main Express app, which requires a full
  // reboot — Express doesn't support adding/removing middleware dynamically.
  if (mode === 'same-port' || prevMode === 'same-port') {
    mStreamServer.reboot();
    return;
  }

  // disabled ↔ separate-port: just manage SSDP and the separate server directly
  dlnaSsdp.stop();
  dlnaServer.stop();
  if (mode !== 'disabled') { dlnaSsdp.start(); }
  if (mode === 'separate-port') { dlnaServer.start(); }
}

export async function enableSubsonic(mode, port) {
  const effectivePort = port !== undefined ? port : config.program.subsonic.port;
  if (mode === config.program.subsonic.mode && effectivePort === config.program.subsonic.port) { return; }

  const prevMode = config.program.subsonic.mode;

  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.subsonic) { loadConfig.subsonic = {}; }
  loadConfig.subsonic.mode = mode;
  if (port !== undefined) { loadConfig.subsonic.port = port; }
  await saveFile(loadConfig, config.configFile);
  config.program.subsonic.mode = mode;
  if (port !== undefined) { config.program.subsonic.port = port; }

  // same-port registers /rest/* routes on the main Express app, which needs a
  // full reboot to take effect or be removed. Express doesn't support
  // dynamic middleware removal.
  if (mode === 'same-port' || prevMode === 'same-port') {
    mStreamServer.reboot();
    return;
  }

  // disabled ↔ separate-port: hot-swap the secondary server in place.
  subsonicServer.stop();
  if (mode === 'separate-port') { subsonicServer.start(); }
}

// Federation toggle disabled — see the syncthing import above.
// Re-enable along with the syncthing import + the API endpoint in
// src/api/admin.js when federation comes back.
// export async function enableFederation(val) {
//   const loadConfig = await loadFile(config.configFile);
//   if (!loadConfig.federation) { loadConfig.federation = {}; }
//   loadConfig.federation.enabled = val;
//   await saveFile(loadConfig, config.configFile);
//   config.program.federation.enabled = val;
//   syncthing.setup();
// }

export async function removeSSL() {
  const loadConfig = await loadFile(config.configFile);
  delete loadConfig.ssl;
  await saveFile(loadConfig, config.configFile);
  delete config.program.ssl;
  mStreamServer.reboot();
}

function testSSL(jsonLoad) {
  return new Promise((resolve, reject) => {
    launchWorker('ssl-test', path.join(__dirname, './ssl-test.js'), JSON.stringify(jsonLoad)).on('close', (code) => {
      if (code !== 0) { return reject('SSL Failure'); }
      resolve();
    });
  });
}

export async function setSSL(cert, key) {
  const sslObj = { key, cert };
  await testSSL(sslObj);
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ssl = sslObj;
  await saveFile(loadConfig, config.configFile);
  config.program.ssl = sslObj;
  mStreamServer.reboot();
}

export async function editAutoBootServerAudio(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.autoBootServerAudio = val;
  await saveFile(loadConfig, config.configFile);
  config.program.autoBootServerAudio = val;
}

export async function editRustPlayerPort(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.rustPlayerPort = val;
  await saveFile(loadConfig, config.configFile);
  config.program.rustPlayerPort = val;
}

// ── Torrent (UX-layer settings; no daemon connection yet) ───────────────────
// `client` is the active backend identifier; v1 supports 'disabled' and
// 'transmission'. `enabledFor` is the access policy: 'all' or 'whitelist'.
// Both are persisted to the config file and reflected immediately in
// config.program so the next request observes the new value without a
// reboot.

export async function editTorrentClient(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.torrent) { loadConfig.torrent = {}; }
  loadConfig.torrent.client = val;
  await saveFile(loadConfig, config.configFile);
  config.program.torrent.client = val;
}

export async function editTorrentEnabledFor(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.torrent) { loadConfig.torrent = {}; }
  loadConfig.torrent.enabledFor = val;
  await saveFile(loadConfig, config.configFile);
  config.program.torrent.enabledFor = val;
}

// Persist Transmission RPC credentials. Pass a falsy or empty-host
// object to clear them ("disconnect" semantics — the next status probe
// will return `configured: false`).
//
// We rewrite the whole `transmission` subobject rather than merging:
// "Connect" is an atomic operation that supplies host, port, username,
// password, etc. all together, and merging would silently leak a
// previous run's stale field if the admin shrinks the form.
export async function editTorrentTransmission(creds) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.torrent) { loadConfig.torrent = {}; }

  if (!creds || !creds.host) {
    // Clear path. Match the in-memory shape to the on-disk one so
    // subsequent reads observe the cleared state.
    loadConfig.torrent.transmission = {
      host:     '',
      port:     9091,
      username: '',
      password: '',
      rpcPath:  '/transmission/rpc',
      useHttps: false,
    };
  } else {
    loadConfig.torrent.transmission = {
      host:     creds.host,
      port:     creds.port,
      username: creds.username || '',
      password: creds.password || '',
      rpcPath:  creds.rpcPath  || '/transmission/rpc',
      useHttps: !!creds.useHttps,
    };
  }
  await saveFile(loadConfig, config.configFile);
  config.program.torrent.transmission = { ...loadConfig.torrent.transmission };
}

// Deluge counterpart. Same atomic-write semantics. Like qBittorrent,
// Deluge's creds shape is a strict subset of Transmission's: there's
// no rpcPath and no separate username (password is the only auth).
export async function editTorrentDeluge(creds) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.torrent) { loadConfig.torrent = {}; }

  if (!creds || !creds.host) {
    loadConfig.torrent.deluge = {
      host:     '',
      port:     8112,
      password: '',
      useHttps: false,
    };
  } else {
    loadConfig.torrent.deluge = {
      host:     creds.host,
      port:     creds.port,
      password: creds.password || '',
      useHttps: !!creds.useHttps,
    };
  }
  await saveFile(loadConfig, config.configFile);
  config.program.torrent.deluge = { ...loadConfig.torrent.deluge };
}

// qBittorrent counterpart. Same atomic-write semantics as
// editTorrentTransmission. Lives in its own helper rather than a
// generic "editTorrentClient(type, creds)" because the two clients'
// credential shapes diverge (no rpcPath on qBittorrent) and a typed
// surface catches "wrong client" mistakes at the call site.
export async function editTorrentQbittorrent(creds) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.torrent) { loadConfig.torrent = {}; }

  if (!creds || !creds.host) {
    loadConfig.torrent.qbittorrent = {
      host:     '',
      port:     8080,
      username: '',
      password: '',
      useHttps: false,
    };
  } else {
    loadConfig.torrent.qbittorrent = {
      host:     creds.host,
      port:     creds.port,
      username: creds.username || '',
      password: creds.password || '',
      useHttps: !!creds.useHttps,
    };
  }
  await saveFile(loadConfig, config.configFile);
  config.program.torrent.qbittorrent = { ...loadConfig.torrent.qbittorrent };
}

// Per-user whitelist flag. Only consulted when
// config.program.torrent.enabledFor === 'whitelist'; in 'all' mode every
// authenticated user has access regardless. Default at row-creation is
// 0 (fail-closed) — see SCHEMA_V36.
export async function editUserAllowTorrent(username, allowTorrent) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  db.getDB().prepare(
    'UPDATE users SET allow_torrent = ? WHERE id = ?'
  ).run(allowTorrent ? 1 : 0, user.id);

  db.invalidateCache();
}
