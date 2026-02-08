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
      winston.warn(`Failed to access file ${file} in directory ${directory}, skipping.`);
      winston.warn(error);
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
      const fileInfo = {
        type: extension,
        name: file
      };

      if (pm) {
        fileInfo.metadata = dbApi.pullMetaData(path.join(metaDir, file).replace(/\\/g, '/'), user);
      }

      rt.files.push(fileInfo);
    }
  }

  if (sort && sort === true) {
    // Sort it because we can't rely on the OS returning it pre-sorted
    rt.directories.sort((a, b) => { return a.name.localeCompare(b.name); });
    rt.files.sort((a, b) => { return a.name.localeCompare(b.name); });
  }

  return rt;
}
