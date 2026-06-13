import fs from 'fs/promises';
import path from 'path';
import winston from 'winston';
import * as dbApi from '../api/db.js';

export function getFileType(pathString) {
  return path.extname(pathString).substr(1);
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
