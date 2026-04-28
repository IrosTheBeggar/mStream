import fs from 'fs/promises';

export async function readPlaylistSongs(filePath) {
  const fileContents = (await fs.readFile(filePath)).toString();

  const items = fileContents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return items
    .map(item => item.replace(/\\/g, "/"))
    .filter(item => {
      // Reject absolute paths and path traversal attempts
      if (!item) return false;
      if (item.startsWith('/') || item.startsWith('\\')) return false;
      if (/^[a-zA-Z]:/.test(item)) return false; // Windows absolute (C:\...)
      if (item.includes('..')) return false;
      return true;
    });
}
