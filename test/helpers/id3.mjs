/**
 * Minimal ID3v2.3 frame surgery for fixture generation.
 *
 * ffmpeg's mp3 muxer only writes frames from its own known-tag table, so
 * iTunes-style frames like TCMP (compilation) are NOT expressible through
 * `-metadata`: both `-metadata compilation=1` and `-metadata TCMP=1` land
 * in TXXX frames that neither music-metadata's common.compilation nor
 * lofty's FlagCompilation reads. Fixtures that need such frames let
 * ffmpeg write the tags it CAN express, then append the rest here.
 */

import fs from 'node:fs/promises';

// One ID3v2.3 text frame: latin1 body (encoding byte 0x00), plain
// big-endian size — v2.3 frame sizes are NOT syncsafe.
export function id3TextFrame(id, text) {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Split a buffer into { frames, audio }: the concatenated frame data of
// the leading ID3v2.3 tag (padding stripped) and everything after the
// tag. Only handles what our ffmpeg invocations produce — v2.3, no
// unsync/extended-header flags — and throws on anything else rather
// than silently corrupting a fixture.
function splitId3v23(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') {
    return { frames: Buffer.alloc(0), audio: buf };
  }
  if (buf[3] !== 0x03) { throw new Error(`expected ID3v2.3, got v2.${buf[3]}`); }
  if (buf[5] !== 0x00) { throw new Error(`unsupported ID3v2 flags 0x${buf[5].toString(16)}`); }
  const tagSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const tagEnd = 10 + tagSize;
  let pos = 10;
  while (pos + 10 <= tagEnd && buf[pos] !== 0x00) {
    pos += 10 + buf.readUInt32BE(pos + 4);
  }
  if (pos > tagEnd) { throw new Error('ID3v2.3 frame overruns tag boundary'); }
  return { frames: buf.subarray(10, pos), audio: buf.subarray(tagEnd) };
}

/**
 * Append text frames to the ID3v2.3 tag at the head of an MP3 (creating
 * the tag if the file has none). `tags` maps frame id → value, e.g.
 * `{ TCMP: '1' }`. Audio bytes are untouched, so audio_hash is stable.
 */
export async function appendId3v23TextFrames(filepath, tags) {
  const { frames, audio } = splitId3v23(await fs.readFile(filepath));
  const appended = Buffer.concat([
    frames,
    ...Object.entries(tags).map(([id, value]) => id3TextFrame(id, value)),
  ]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 0x03;
  header[6] = (appended.length >> 21) & 0x7f;
  header[7] = (appended.length >> 14) & 0x7f;
  header[8] = (appended.length >> 7) & 0x7f;
  header[9] = appended.length & 0x7f;
  await fs.writeFile(filepath, Buffer.concat([header, appended, audio]));
}
