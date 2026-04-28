import yazl from 'yazl';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import winston from 'winston';

export function createZipForResponse(res, downloadFilename, errorLabel) {
  res.attachment(downloadFilename);
  const zipFile = new yazl.ZipFile();
  zipFile.outputStream.on('error', err => {
    winston.error(errorLabel, { stack: err });
    if (!res.headersSent) {
      res.status(500).json({ error: errorLabel });
    }
  });
  zipFile.outputStream.pipe(res);
  return zipFile;
}

export async function addDirectoryRecursive(zipFile, srcDir) {
  const entries = await fs.readdir(srcDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(srcDir, full).replace(/\\/g, '/');
    zipFile.addFile(full, rel);
  }
}
