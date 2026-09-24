// What the discovery plug-ins brought into the library, and taking one out
// again (src/db/plugin-downloads.js, V75).
//
//   GET    /api/v1/discovery/downloads        the caller's downloads, newest first
//                                             (admins: ?all=1 for every account's);
//                                             ?removed=1 includes history, ?limit, ?before=<id>
//   DELETE /api/v1/discovery/downloads/:id    remove a download: the file, its library row,
//                                             the playlist entries that pointed at it
//
// Removing is the first place the API deletes music, so the rule is narrow:
// the account that asked for the download, or an admin. Anyone else gets the
// same 404 as an unknown id. A file that is already gone (a scan swept it, a
// hand removed it) still settles the record; a file the OS holds open is
// refused with a 409 rather than half-removed. Ratings and play counts key
// on the recording's hash and are left alone, as the scanner's own sweep
// leaves them.

import Joi from 'joi';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as db from '../db/manager.js';
import * as downloadsDb from '../db/plugin-downloads.js';
import * as vpathUtil from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

function isAdmin(user) { return !!(user && user.admin === true); }
function callerId(req) { return req.user ? req.user.id : null; }

// The anonymous account of a server with no users has an internal name
// that means nothing to an operator; a user's own list needs no names.
function withNames(rows, everyone) {
  if (!everyone) { return rows.map((r) => ({ ...r, username: undefined })); }
  const anonId = db.getAnonymousUserId();
  return rows.map((r) => ({ ...r, username: (r.userId !== anonId && r.username) || null }));
}

export function setup(mstream) {
  mstream.get('/api/v1/discovery/downloads', (req, res) => {
    const schema = Joi.object({
      all: Joi.boolean().truthy('1').falsy('0').default(false),
      removed: Joi.boolean().truthy('1').falsy('0').default(false),
      limit: Joi.number().integer().min(1).max(500).default(100),
      before: Joi.number().integer().positive().optional(),
    });
    const { value } = joiValidate(schema, req.query || {});
    const everyone = value.all === true && isAdmin(req.user);
    const rows = downloadsDb.list({
      userId: everyone ? undefined : callerId(req),
      includeRemoved: value.removed === true,
      limit: value.limit,
      before: value.before || null,
    });
    res.json({ downloads: withNames(rows, everyone) });
  });

  mstream.delete('/api/v1/discovery/downloads/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { throw new WebError('download not found', 404); }
    const row = downloadsDb.get(id);
    if (!row || (!isAdmin(req.user) && row.userId !== callerId(req))) { throw new WebError('download not found', 404); }
    if (row.removedAt) { throw new WebError('this download was already removed', 409); }

    // Where the library says the file is. The requester still needs the
    // library; an admin may reach into any. A library that no longer exists
    // has nothing to remove: the record just settles.
    let info = null;
    try {
      info = vpathUtil.getVPathInfo(row.filepath, isAdmin(req.user) ? null : req.user);
    } catch (err) {
      if (!isAdmin(req.user) && db.getLibraryByName(row.vpath)) {
        throw new WebError('the library this download landed in is no longer yours', 404);
      }
      winston.warn(`discovery downloads: ${row.filepath} cannot be resolved (${err.message}); settling the record`);
    }

    let fileRemoved = false;
    if (info) {
      const there = await fs.stat(info.fullPath).then((s) => s.isFile(), () => false);
      if (there) {
        try {
          await fs.unlink(info.fullPath);
          fileRemoved = true;
        } catch (err) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
            winston.warn(`discovery downloads: removing ${row.filepath} blocked (${err.code}) — the file is in use`);
            throw new WebError('the file is in use — try again in a moment', 409);
          }
          throw err;
        }
      }
    }
    const { removeDownloadedTrack } = await import('../db/insert-downloaded-track.js');
    const rowsRemoved = removeDownloadedTrack({ vpath: row.vpath, relativePath: row.relativePath, log: 'discovery downloads' });
    const playlistEntries = db.getDB().prepare('DELETE FROM playlist_tracks WHERE filepath = ?').run(row.filepath).changes;
    const removed = downloadsDb.markRemoved(id, { by: callerId(req) });
    winston.info(`discovery downloads: ${(req.user && req.user.username) || 'anonymous'} removed ${row.filepath}`
      + ` (file ${fileRemoved ? 'deleted' : 'was already gone'}, ${rowsRemoved} row(s), ${playlistEntries} playlist entr${playlistEntries === 1 ? 'y' : 'ies'})`);
    res.json({ download: removed, fileRemoved, rowsRemoved, playlistEntries });
  });
}
