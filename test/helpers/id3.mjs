/**
 * Minimal ID3v2 frame surgery for fixture generation.
 *
 * ffmpeg's mp3 muxer only writes frames from its own known-tag table, so
 * iTunes-style frames like TCMP (compilation) are NOT expressible through
 * `-metadata`: both `-metadata compilation=1` and `-metadata TCMP=1` land
 * in TXXX frames that neither music-metadata's common.compilation nor
 * lofty's FlagCompilation reads. Fixtures that need such frames let
 * ffmpeg write the tags it CAN express, then append the rest here.
 *
 * V72: also handles ID3v2.4 tags (syncsafe frame sizes) and non-latin1
 * encodings, so fixtures can carry a null-separated multi-value TPE1 —
 * the one multi-value form ffmpeg cannot write from argv.
 */

import fs from 'node:fs/promises';

function writeSyncsafe(buf, at, n) {
  buf[at]     = (n >> 21) & 0x7f;
  buf[at + 1] = (n >> 14) & 0x7f;
  buf[at + 2] = (n >> 7) & 0x7f;
  buf[at + 3] = n & 0x7f;
}
const readSyncsafe = (buf, at) =>
  ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);

// One ID3v2 text frame. `text` may contain "\0" (a v2.4 value separator).
// encoding: 'latin1' (byte 0x00, default), 'utf16' (0x01, BOM + UTF-16LE),
// 'utf16be' (0x02), 'utf8' (0x03). v2.3 frame sizes are plain big-endian,
// v2.4 sizes are syncsafe.
export function id3TextFrame(id, text, { version = 3, encoding = 'latin1' } = {}) {
  let body;
  if (encoding === 'latin1')      { body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]); }
  else if (encoding === 'utf16')  { body = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]); }
  else if (encoding === 'utf16be') {
    const le = Buffer.from(text, 'utf16le'); le.swap16();
    body = Buffer.concat([Buffer.from([0x02]), le]);
  }
  else if (encoding === 'utf8')   { body = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]); }
  else { throw new Error(`unknown encoding ${encoding}`); }
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  if (version === 4) { writeSyncsafe(head, 4, body.length); } else { head.writeUInt32BE(body.length, 4); }
  return Buffer.concat([head, body]);
}

// Split a buffer into { version, frames, audio }: the concatenated frame
// data of the leading ID3v2 tag (padding stripped) and everything after
// the tag. Only handles what our ffmpeg invocations produce — v2.3 or
// v2.4, no unsync/extended-header flags — and throws on anything else
// rather than silently corrupting a fixture. A file without a tag yields
// version null.
function splitId3v2(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') {
    return { version: null, frames: Buffer.alloc(0), audio: buf };
  }
  const version = buf[3];
  if (version !== 0x03 && version !== 0x04) { throw new Error(`expected ID3v2.3/4, got v2.${version}`); }
  if (buf[5] !== 0x00) { throw new Error(`unsupported ID3v2 flags 0x${buf[5].toString(16)}`); }
  const tagSize = readSyncsafe(buf, 6);
  const tagEnd = 10 + tagSize;
  let pos = 10;
  while (pos + 10 <= tagEnd && buf[pos] !== 0x00) {
    pos += 10 + (version === 4 ? readSyncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4));
  }
  if (pos > tagEnd) { throw new Error('ID3v2 frame overruns tag boundary'); }
  return { version, frames: buf.subarray(10, pos), audio: buf.subarray(tagEnd) };
}

/**
 * Append text frames to the ID3v2 tag at the head of a file (creating the
 * tag if the file has none — `version` then picks v2.3 or v2.4, default
 * 3). `tags` maps frame id → value; a value may also be
 * `{ text, encoding }`. Audio bytes are untouched, so audio_hash is stable.
 */
export async function appendId3TextFrames(filepath, tags, { version = 3 } = {}) {
  const parsed = splitId3v2(await fs.readFile(filepath));
  const v = parsed.version ?? version;
  const appended = Buffer.concat([
    parsed.frames,
    ...Object.entries(tags).map(([id, value]) => (
      typeof value === 'object' && value !== null
        ? id3TextFrame(id, value.text, { version: v, encoding: value.encoding })
        : id3TextFrame(id, value, { version: v })
    )),
  ]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = v;
  writeSyncsafe(header, 6, appended.length);
  await fs.writeFile(filepath, Buffer.concat([header, appended, parsed.audio]));
}

/**
 * v2.3-only form kept for the existing fixtures: throws when the file's
 * tag is not v2.3 (a v2.4 fixture must say so — see appendId3TextFrames).
 */
export async function appendId3v23TextFrames(filepath, tags) {
  const { version } = splitId3v2(await fs.readFile(filepath));
  if (version !== null && version !== 3) { throw new Error(`expected ID3v2.3, got v2.${version}`); }
  await appendId3TextFrames(filepath, tags, { version: 3 });
}
