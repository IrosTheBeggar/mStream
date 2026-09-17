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

export function retentionDays() {
  const n = Number(cfg().retentionDays);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

export function expiresAt(from = Date.now()) {
  return from + retentionDays() * 24 * 60 * 60 * 1000;
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
