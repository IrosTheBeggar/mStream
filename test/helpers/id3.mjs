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
export function id3Frame(id, body, { major = 3, flags = 0, declared = body.length, plainSize = false } = {}) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  // `plainSize` writes a v2.4 size as a plain big-endian number — the
  // LAME 3.97-era mistake the scanners' normalisers repair.
  if (major === 4 && !plainSize) { syncsafeBytes(declared).copy(head, 4); } else { head.writeUInt32BE(declared, 4); }
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

// A TXXX body: latin1 encoding, a NUL-terminated description, the text.
export function id3TxxxBody(description, text) {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(description, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
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

// ── ID3v1 and APEv2, the tags at the END of a file ──────────────────────────

// An ID3v1.1 tag: 128 bytes, fixed-width latin1 fields padded with spaces
// (the padding music-metadata trims and lofty keeps), a track byte, a
// genre index (255 = none).
export function id3v1Tag({ title = '', artist = '', album = '', year = '', comment = '', track = 0, genre = 255 } = {}) {
  const field = (text, n) => { const b = Buffer.alloc(n, 0x20); Buffer.from(text, 'latin1').copy(b, 0, 0, n); return b; };
  return Buffer.concat([
    Buffer.from('TAG', 'latin1'), field(title, 30), field(artist, 30), field(album, 30), field(year, 4),
    field(comment, 28), Buffer.from([0x00, track & 0xff, genre & 0xff]),
  ]);
}

export async function appendId3v1Tag(filepath, fields) {
  await fs.appendFile(filepath, id3v1Tag(fields));
}

// An APEv2 tag (header, items, footer) for the end of an MP3. Items are
// `{ key, value }` (UTF-8 text) or `{ key, data }` (binary — a cover is
// `filename\0` + the picture bytes, the APE convention).
export function apeTag(items) {
  const body = Buffer.concat(items.map(({ key, value, data }) => {
    const val = data ? data : Buffer.from(value, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(val.length, 0);
    head.writeUInt32LE(data ? 0x02 : 0x00, 4);   // item type: text 0, binary 1 (bits 1-2)
    return Buffer.concat([head, Buffer.from(key, 'latin1'), Buffer.from([0x00]), val]);
  }));
  const block = (isHeader) => {
    const b = Buffer.alloc(32);
    b.write('APETAGEX', 0, 'latin1');
    b.writeUInt32LE(2000, 8);                     // version
    b.writeUInt32LE(body.length + 32, 12);        // size: items + footer
    b.writeUInt32LE(items.length, 16);
    b.writeUInt32LE((0x80000000 | (isHeader ? 0x20000000 : 0)) >>> 0, 20);   // has header; is header
    return b;
  };
  return Buffer.concat([block(true), body, block(false)]);
}

export async function appendApeTag(filepath, items) {
  await fs.appendFile(filepath, apeTag(items));
}
