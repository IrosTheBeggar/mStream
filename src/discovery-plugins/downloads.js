// "Discover downloads" — the scratch library acquire plug-ins land files
// in (design cards 03 and 07). A real folder in the library tree, so a
// download plays, lists and searches like any song, but with an expiry:
// files nobody kept are swept after `discoveryJobs.downloads.retentionDays`
// (the sweep and Keep… are the next slice). One subfolder per user.
//
// The library is created the first time a job needs it — never at boot, so
// a server with every acquire plug-in off never grows a folder it does not
// use. Created the way an admin-added folder is (libraries row, granted to
// every user, served under /media/<name>/ with the same vpath check the
// boot-time mounts apply); on later boots server.js mounts it like any
// other library.

import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as vpathUtil from '../util/vpath.js';
import * as destinations from './destination.js';
import WebError from '../util/web-error.js';

export const LIBRARY_NAME = 'discover-downloads';

let app = null;
let mountedHere = false;

// server.js hands over the Express app so a library created at runtime can
// be served without a reboot.
export function attachApp(mstream) { app = mstream; }

function cfg() {
  const d = config.program && config.program.discoveryJobs && config.program.discoveryJobs.downloads;
  return d || {};
}

export function downloadsDir() {
  return cfg().dir;
}

// Days an unkept download lives; 0 = never swept.
export function retentionDays() {
  const n = Number(cfg().retentionDays);
  return Number.isInteger(n) && n >= 0 ? n : 30;
}

// When a download that landed at `from` (ms) expires under the CURRENT
// setting — computed on read, never stored, so changing the retention
// changes what users are told. null = never.
export function expiresAt(from = Date.now()) {
  const days = retentionDays();
  return days > 0 && Number.isFinite(from) ? from + days * 24 * 60 * 60 * 1000 : null;
}

// The per-user subfolder name: the username, made path-safe; the anonymous
// account of a public-mode server shares one folder.
export function folderNameFor(user) {
  const anonId = db.getAnonymousUserId();
  if (!user || user.id == null || (anonId != null && user.id === anonId) || !user.username) { return 'shared'; }
  // eslint-disable-next-line no-control-regex
  const safe = String(user.username).replace(/[/\\:*?<>|"\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
  return safe || 'shared';
}

// The user a job runs for, rebuilt from its id (the request is gone).
export function userForJob(userId) {
  const anonId = db.getAnonymousUserId();
  if (userId == null || (anonId != null && userId === anonId)) { return { id: anonId, username: null }; }
  return db.getAllUsers().find((u) => u.id === userId) || null;
}

// Create the library on first use and make sure `user` can see it.
export async function ensureLibrary(user) {
  const dir = downloadsDir();
  if (!dir) { throw new Error('discoveryJobs.downloads.dir is not configured'); }
  await fs.mkdir(dir, { recursive: true });
  const d = db.getDB();
  let lib = db.getLibraryByName(LIBRARY_NAME);
  let created = false;
  if (!lib) {
    d.prepare('INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, ?, 0)').run(LIBRARY_NAME, dir, 'music');
    const libraryId = Number(d.prepare('SELECT id FROM libraries WHERE name = ?').get(LIBRARY_NAME).id);
    const grant = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
    for (const u of db.getAllUsers()) { grant.run(u.id, libraryId); }
    db.invalidateCache();
    lib = db.getLibraryByName(LIBRARY_NAME);
    created = true;
    winston.info(`discovery downloads: created library '${LIBRARY_NAME}' at ${dir}`);
  } else if (user && user.id != null && user.username) {
    // A user created after the library was: grant on first use.
    const r = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(user.id, lib.id);
    if (r.changes > 0) { db.invalidateCache(); }
  }
  if (created && app && !mountedHere) {
    // The boot-time /media/:vpath dispatcher only knows the libraries that
    // existed then; serve this one behind the same vpath check.
    const serve = express.static(lib.root_path);
    app.use(`/media/${LIBRARY_NAME}`, (req, res, next) => {
      if (!req.user || !Array.isArray(req.user.vpaths) || !req.user.vpaths.includes(LIBRARY_NAME)) { return next(); }
      return serve(req, res, next);
    });
    mountedHere = true;
  }
  return lib;
}

// The folder a user's downloads go to, created if needed.
export async function userDir(user) {
  const dir = path.join(downloadsDir(), folderNameFor(user));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Keep…: move a finished download out of the scratch library into the
// user's collection destination (destination.js; the caller resolved and
// checked it) and amend the job. The file's own tags render the layout —
// they were written from the recommendation at download time. Never
// overwrites; a file Windows still holds open (it is playing) is refused,
// not half-moved. Ratings and play counts key on the track hash, so they
// follow the file by themselves; playlists key on the path, so their entries
// are rewritten here. `req`-free on purpose: the route owns the HTTP rules.
export async function keepDownload({ job, user, destination }) {
  const from = job.result.downloaded.filepath;   // "discover-downloads/<user>/<file>"
  let srcInfo;
  try {
    srcInfo = vpathUtil.getVPathInfo(from, user);
  } catch (err) {
    winston.warn(`discovery downloads: keep of job ${job.id} refused — ${err.message}`);
    throw new WebError('the download is no longer in your library', 409);
  }
  const stat = await fs.stat(srcInfo.fullPath).catch(() => null);
  if (!stat || !stat.isFile()) { throw new WebError('the download is gone — it expired or was removed', 409); }

  let common = {};
  try {
    const { parseFile } = await import('music-metadata');
    common = (await parseFile(srcInfo.fullPath, { skipCovers: true })).common || {};
  } catch (err) {
    winston.warn(`discovery downloads: could not read tags from ${from} (${err.message}); using the recommendation's`);
  }
  const tags = destinations.tagsForLayout(common, job.recommendation || {});
  const target = destinations.renderTarget({ destination, tags, peerName: null, fileName: destinations.safeFileName(from) });
  const targetInfo = vpathUtil.getVPathInfo(`${destination.vpath}/${target.relPath}`, user);
  if (await fs.stat(targetInfo.fullPath).then(() => true, () => false)) {
    throw new WebError(`a file already exists at ${destination.vpath}/${target.relPath}`, 409);
  }

  await fs.mkdir(path.dirname(targetInfo.fullPath), { recursive: true });
  try {
    await fs.rename(srcInfo.fullPath, targetInfo.fullPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Another drive: copy, then drop the original.
      await fs.copyFile(srcInfo.fullPath, targetInfo.fullPath);
      await fs.unlink(srcInfo.fullPath).catch((e) => winston.warn(`discovery downloads: kept ${from} but could not remove the original: ${e.message}`));
    } else if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      winston.warn(`discovery downloads: keep of ${from} blocked (${err.code}) — the file is in use`);
      throw new WebError('the file is in use — try again in a moment', 409);
    } else {
      throw err;
    }
  }

  // Loaded here, not at the top: the insert helper pulls in the tag parser
  // and the thumbnailer, which the plug-in registry has no business loading.
  const { insertDownloadedTrack, removeDownloadedTrack } = await import('../db/insert-downloaded-track.js');
  removeDownloadedTrack({ vpath: LIBRARY_NAME, relativePath: srcInfo.relativePath, log: 'discover-keep' });
  const inserted = await insertDownloadedTrack({
    filePath: targetInfo.fullPath, vpath: destination.vpath, basePath: targetInfo.basePath,
    source: `plugin:${job.plugin}`, log: 'discover-keep',
  });
  const to = `${destination.vpath}/${inserted.relativePath}`;
  const playlistEntries = db.getDB().prepare('UPDATE playlist_tracks SET filepath = ? WHERE filepath = ?').run(to, from).changes;
  winston.info(`discovery downloads: kept ${from} as ${to}${playlistEntries ? ` (${playlistEntries} playlist entr${playlistEntries === 1 ? 'y' : 'ies'} followed)` : ''}`);
  return jobsDb.patchResult(job.id, {
    kept: { vpath: destination.vpath, filepath: to, trackId: inserted.trackId, playlistEntries, missingVars: target.missingVars, at: Date.now() },
  });
}
