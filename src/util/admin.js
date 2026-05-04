import fs from 'fs/promises';
import path from 'path';
import child from 'child_process';
import express from 'express';
import * as auth from './auth.js';
import * as config from '../state/config.js';
import * as mStreamServer from '../server.js';
import * as dbQueue from '../db/task-queue.js';
import * as logger from '../logger.js';
import * as db from '../db/manager.js';
import * as syncthing from '../state/syncthing.js';
import * as dlnaSsdp from '../dlna/ssdp.js';
import * as dlnaServer from '../dlna/dlna-server.js';
import * as subsonicServer from '../subsonic/subsonic-server.js';
import { getDirname } from './esm-helpers.js';

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

  // Clean up orphaned artists/albums. Keep artists referenced by either
  // the single-valued FKs OR the V17 M2M tables — otherwise cascade would
  // drop track_artists/album_artists rows for featured/co-credited artists.
  //
  // CHUNKED, not one big DELETE: removing a vpath that owned a large
  // chunk of the catalog cascades through tracks → orphans most of the
  // artists. The 4-way NOT IN scan in the artists DELETE can run past
  // 5 seconds, holding the SQLite writer lock for the whole window
  // and starving any concurrent API writes (busy_timeout = 5000ms →
  // SQLITE_BUSY). Worse here than in the scanner because this runs
  // INSIDE the main Node process — a multi-second sync DELETE blocks
  // every other request handler too. Chunking releases the writer (and
  // the JS event loop, in spirit) between batches.
  chunkedOrphanDelete(d, 'albums',
    'SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)');
  chunkedOrphanDelete(d, 'artists',
    `SELECT id FROM artists
      WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks         WHERE artist_id IS NOT NULL)
        AND id NOT IN (SELECT DISTINCT artist_id FROM albums         WHERE artist_id IS NOT NULL)
        AND id NOT IN (SELECT DISTINCT artist_id FROM track_artists)
        AND id NOT IN (SELECT DISTINCT artist_id FROM album_artists)`);

  db.invalidateCache();

  // Reboot to remove the static route
  mStreamServer.reboot();
}

// Per-chunk row cap for orphan cleanup after a vpath delete. Mirrors
// the same constant + helper in src/db/scanner.mjs (the scanner runs
// in its own process, so the duplication is intentional rather than
// importing across the process boundary). See removeDirectory's
// CHUNKED comment for the lock-contention rationale.
const ORPHAN_CHUNK_SIZE = 500;

function chunkedOrphanDelete(conn, table, selectIdsSql) {
  // SQLite's bundled build doesn't ship with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
  // so the LIMIT goes on a subselect rather than the DELETE itself.
  const stmt = conn.prepare(
    `DELETE FROM ${table} WHERE id IN (${selectIdsSql} LIMIT ${ORPHAN_CHUNK_SIZE})`,
  );
  while (true) {
    const r = stmt.run();
    if (r.changes === 0) { break; }
  }
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

export async function editAutoAlbumArt(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArt = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArt = val;
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

export async function editWriteLogs(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await saveFile(loadConfig, config.configFile);
  config.program.writeLogs = val;
  if (val === false) { logger.reset(); }
  else { logger.addFileLogger(config.program.storage.logsDirectory); }
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

export async function lockAdminApi(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.lockAdmin = val;
  await saveFile(loadConfig, config.configFile);
  config.program.lockAdmin = val;
}

export async function editDlnaBrowse(browse) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.browse = browse;
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.browse = browse;
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

export async function enableFederation(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.federation) { loadConfig.federation = {}; }
  loadConfig.federation.enabled = val;
  await saveFile(loadConfig, config.configFile);
  config.program.federation.enabled = val;
  syncthing.setup();
}

export async function removeSSL() {
  const loadConfig = await loadFile(config.configFile);
  delete loadConfig.ssl;
  await saveFile(loadConfig, config.configFile);
  delete config.program.ssl;
  mStreamServer.reboot();
}

function testSSL(jsonLoad) {
  return new Promise((resolve, reject) => {
    child.fork(path.join(__dirname, './ssl-test.js'), [JSON.stringify(jsonLoad)], { silent: true }).on('close', (code) => {
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
