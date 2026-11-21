import fs from 'fs/promises';
import * as m3u8Parser from 'm3u8-parser';

export async function readPlaylistSongs(filePath) {
  const fileContents = (await fs.readFile(filePath)).toString();

  const parser = new m3u8Parser.Parser();
  parser.push(fileContents);
  parser.end();

  let items = parser.manifest.segments.map(segment => { return segment.uri; });
  if (items.length === 0) {
    // The parser fills `segments` only once it meets an #EXTINF, so a plain
    // list (paths alone, maybe under an #EXTM3U header) is split here, line
    // by line as the parser reads: trimmed, blank lines skipped, and a line
    // that starts with '#' is a directive or a comment, not a song.
    items = fileContents.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  }

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
