import fs from 'fs/promises';
import path from 'path';
import winston from 'winston';
import * as dbApi from '../api/db.js';
import WebError from './web-error.js';

export function getFileType(pathString) {
  return path.extname(pathString).substr(1);
}

// A filesystem failure on a path the CALLER named is the caller's path, not
// the server's health: the folder or file is gone, is the wrong kind, or is
// unreadable by the account mStream runs as. pathReadError maps those to the
// client errors they are, code in the message so the reason is visible from
// the API, instead of the bare 500 "Server Error" that hid the cause in the
// log. Codes outside the table (EIO, EMFILE, …) come back unchanged, so the
// terminal handler still treats them as the server trouble they are (error
// level, stack). ERR_INVALID_ARG_VALUE is Node's own rejection of a path
// containing a NUL byte, raised before any syscall — still the caller's
// path, so 400.
//
// `displayPath` is what the message shows. The admin explorer passes the
// absolute path (admins browse the whole filesystem, nothing to hide); the
// user-facing explorer and download routes pass the caller's own VIRTUAL
// path, so a non-admin never learns where a library lives on disk. `kind`
// names what was being read ("directory", "playlist").
export const READ_ERROR_STATUS = Object.freeze({
  ENOENT: 404, ENOTDIR: 404, EISDIR: 404,
  EACCES: 400, EPERM: 400, EINVAL: 400, ENAMETOOLONG: 400, ELOOP: 400,
  ERR_INVALID_ARG_VALUE: 400,
});
export function pathReadError(displayPath, err, kind = 'directory') {
  const status = READ_ERROR_STATUS[err?.code];
  if (!status) { return err; }
  return new WebError(`Cannot read ${kind} "${displayPath}" (${err.code})`, status);
}

export async function getDirectoryContents(directory, fileTypeFilter, sort, pm, metaDir, user) {
  const rt = { directories: [], files: [] };
  for (const file of await fs.readdir(directory)) {
    let stat;
    try {
      stat = await fs.stat(path.join(directory, file));
    } catch (error) {
      // Bad file or permission error, ignore and continue
      winston.warn(`Failed to access file ${file} in directory ${directory}, skipping.`, { stack: error });
      continue;
    }

    // Handle Directory
    if (stat.isDirectory()) {
      rt.directories.push({ name: file });
      continue;
    }

    // Handle Files
    const extension = getFileType(file).toLowerCase();
    if (fileTypeFilter && extension in fileTypeFilter) {
      rt.files.push({ type: extension, name: file });
    }
  }

  // Resolve metadata for every audio file in ONE batched query rather than a
  // query per file. The old per-file dbApi.pullMetaData loop re-materialised
  // trackQuery's whole-table genre aggregation on every call, so a folder with
  // N tracks cost N full-table scans (the same N+1 fixed for playlist load).
  // pullMetaDataBatch returns the same { filepath, metadata } wrapper keyed by
  // the input path, so the per-file shape is unchanged.
  if (pm) {
    const filepaths = rt.files.map(f => path.join(metaDir, f.name).replace(/\\/g, '/'));
    const batch = dbApi.pullMetaDataBatch(filepaths, user);
    rt.files.forEach((f, i) => { f.metadata = batch.get(filepaths[i]); });
  }

  if (sort && sort === true) {
    // Sort it because we can't rely on the OS returning it pre-sorted
    rt.directories.sort((a, b) => { return a.name.localeCompare(b.name); });
    rt.files.sort((a, b) => { return a.name.localeCompare(b.name); });
  }

  return rt;
}
