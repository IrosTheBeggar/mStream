import fs from 'fs/promises';
import * as m3u8Parser from 'm3u8-parser';

export async function readPlaylistSongs(filePath) {
  const fileContents = (await fs.readFile(filePath)).toString();

  const parser = new m3u8Parser.Parser();
  parser.push(fileContents);
  parser.end();

  let items = parser.manifest.segments.map(segment => { return segment.uri; });
  if (items.length === 0) {
    items = fileContents.split(/\r?\n/).filter(Boolean);
  }

  return items.map(item => { return item.replace(/\\/g, "/"); });
}
