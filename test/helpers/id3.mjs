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

// ── Generic ID3v2.3 / v2.4 tag construction ─────────────────────────────────
// For fixtures whose TAG is the thing under test (unsynchronisation, odd
// encodings, truncated frames, undecodable pictures): build the tag byte
// by byte, then swap it in for the one ffmpeg wrote.

export function syncsafeBytes(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

// One frame with an explicit body. v2.3 sizes are plain big-endian, v2.4
// sizes syncsafe; `flags` is the 16-bit frame-flag word. `declared` lets
// the header lie about the size (a truncated-frame fixture).
export function id3Frame(id, body, { major = 3, flags = 0, declared = body.length } = {}) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  if (major === 4) { syncsafeBytes(declared).copy(head, 4); } else { head.writeUInt32BE(declared, 4); }
  head.writeUInt16BE(flags, 8);
  return Buffer.concat([head, body]);
}

// A text-frame body: encoding byte + text. 'utf16' is the BOM form
// (encoding 1, little-endian), 'utf8' encoding 3, anything else latin1.
export function id3TextBody(text, encoding = 'latin1') {
  if (encoding === 'utf16') { return Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]); }
  if (encoding === 'utf8') { return Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]); }
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
}

// An APIC body: latin1 encoding, MIME, picture type (3 = front cover), an
// empty description, then the picture bytes verbatim.
export function id3ApicBody(mime, data, { pictureType = 3 } = {}) {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(mime, 'latin1'), Buffer.from([0x00, pictureType, 0x00]), data]);
}

// ID3v2 unsynchronisation: a 0x00 after every 0xFF. (The spec only needs it
// before 0x00 / 0xE0–0xFF; stuffing every 0xFF is a valid, if eager, writer
// — de-unsync is the same either way.)
export function unsyncBytes(buf) {
  const out = [];
  for (const b of buf) { out.push(b); if (b === 0xff) { out.push(0x00); } }
  return Buffer.from(out);
}

// A whole tag: header (major version, tag flags, syncsafe size), frames, padding.
export function buildId3v2Tag(frames, { major = 3, flags = 0, padding = 64 } = {}) {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = major;
  header[5] = flags;
  syncsafeBytes(body.length).copy(header, 6);
  return Buffer.concat([header, body]);
}

// Replace the ID3v2 tag at the head of a file (any version) with `tag`; the
// audio bytes are untouched, so audio_hash stays stable.
export async function replaceId3v2Tag(filepath, tag) {
  const buf = await fs.readFile(filepath);
  let audioStart = 0;
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    audioStart = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
    if (buf[5] & 0x10) { audioStart += 10; }   // footer
  }
  await fs.writeFile(filepath, Buffer.concat([tag, buf.subarray(audioStart)]));
}
