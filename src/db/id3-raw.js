// Raw ID3v2 text-frame reader for the JS scanner's credit extraction (V72).
//
// music-metadata splits ID3v2.2/v2.3 TPE1 / TCOM / TEXT / TOLY / TOPE / TSRC
// on "/" (the v2.3 spec's separator) BEFORE anything reaches `common` — and
// its `native` list is already split too — so a v2.3 tag of "AC/DC" reaches
// the extractor as two values and the raw spelling is gone. The Rust
// scanner (lofty) keeps the frame verbatim and splits only on the v2.4
// NUL separator. To keep both engines on the same rules
// (src/db/artist-extraction.js: only a single-valued tag is
// delimiter-split, and the display string is the tag as written), the JS
// scanner reads the credit frames straight from the file:
//
//   one entry per NUL-separated value (v2.4), else one entry per frame —
//   the split lofty performs on every version.
//
// Handles ID3v2.2 (3-byte frame ids: TP1 TP2 TCM TP3 TP4 TXT), v2.3 and
// v2.4; a tag at the head of the file (MP3, AAC, DSF prefix) or inside the
// `id3 ` chunk of a RIFF/WAVE or AIFF container; CHAINED tags (a re-tagger
// that appended a v2.4 tag after the original v2.3 one — the later tag's
// frames replace the earlier tag's for the same id, the way lofty and
// music-metadata resolve them); tag-level (v2.3) and frame-level (v2.4)
// unsynchronisation; the v2.3/v2.4 extended header; v2.4 data-length
// indicators and grouping bytes; latin1 / UTF-16 (BOM per value) /
// UTF-16BE / UTF-8 text. Each tag is read in ONE positional read.
//
// Returns { TPE1: [...], TPE2: [...], ... } (v2.4 frame ids, v2.2 ids
// mapped) for the frames present, or null when the file has no ID3v2 tag
// this reader can use, or a WANTED frame is compressed / encrypted — the
// caller then falls back to music-metadata's view (and knows it is the
// pre-split one). Read errors are logged (the scanner child has no
// winston; it logs with console.error like its other warnings).

import fs from 'node:fs';

export const CREDIT_FRAME_IDS = ['TPE1', 'TPE2', 'TCOM', 'TPE3', 'TPE4', 'TEXT'];

const V22_IDS = { TP1: 'TPE1', TP2: 'TPE2', TCM: 'TCOM', TP3: 'TPE3', TP4: 'TPE4', TXT: 'TEXT' };
const MAX_TAG_BYTES = 64 * 1024 * 1024;   // an ID3 tag past this is not something we read for credits
const MAX_TEXT_FRAME = 64 * 1024;         // a text frame past this is not a credit
const MAX_CHAINED_TAGS = 4;

export function syncsafe(buf, at) {
  return ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14)
       | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
}

// Undo unsynchronisation: every 0xFF 0x00 pair is a stuffed 0xFF.
function deunsync(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    out[n++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) { i++; }
  }
  return out.subarray(0, n);
}

// Decode a text-frame body (encoding byte + text) to its values.
function decodeText(body) {
  if (body.length < 1) { return []; }
  const enc = body[0];
  let text;
  if (enc === 0x00) {
    text = body.toString('latin1', 1);
  } else if (enc === 0x03) {
    text = body.toString('utf8', 1);
  } else if (enc === 0x01 || enc === 0x02) {
    // UTF-16: values are separated by a 16-bit NUL and (v2.4) EACH string
    // carries its own BOM — decode per string, so a mixed-endian frame and
    // a stray BOM before the second value both come out right.
    let payload = body.subarray(1);
    if (payload.length % 2 === 1) { payload = payload.subarray(0, payload.length - 1); }
    const parts = [];
    let start = 0;
    for (let i = 0; i <= payload.length; i += 2) {
      if (i === payload.length || (payload[i] === 0x00 && payload[i + 1] === 0x00)) {
        let seg = payload.subarray(start, i);
        let bigEndian = enc === 0x02;
        if (seg.length >= 2 && seg[0] === 0xfe && seg[1] === 0xff) { bigEndian = true;  seg = seg.subarray(2); }
        else if (seg.length >= 2 && seg[0] === 0xff && seg[1] === 0xfe) { bigEndian = false; seg = seg.subarray(2); }
        if (bigEndian) { seg = Buffer.from(seg); seg.swap16(); }
        parts.push(seg.toString('utf16le'));
        start = i + 2;
      }
    }
    text = parts.join('\0');
  } else {
    return null;                                  // unknown encoding → bail
  }
  // v2.4 separates multiple values with NUL; older frames end in an optional
  // terminator (and some taggers embed separators there too — lofty and
  // music-metadata both treat them as separate values). Split, drop empties.
  return text.split('\0').filter((v) => v.length > 0);
}

// Locate the first ID3v2 tag: offset 0, or the `id3 `/`ID3 ` chunk of a
// RIFF (little-endian sizes) or AIFF FORM (big-endian sizes) container.
// Returns the byte offset of the "ID3" marker or -1.
function findTagOffset(fd) {
  const head = Buffer.alloc(12);
  const n = fs.readSync(fd, head, 0, 12, 0);
  if (n < 10) { return -1; }
  if (head.toString('latin1', 0, 3) === 'ID3') { return 0; }
  if (n < 12) { return -1; }
  const magic = head.toString('latin1', 0, 4);
  const riff = magic === 'RIFF';
  if (!riff && magic !== 'FORM') { return -1; }
  const size = fs.fstatSync(fd).size;
  let pos = 12;
  const ch = Buffer.alloc(8);
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    if (fs.readSync(fd, ch, 0, 8, pos) !== 8) { return -1; }
    const id = ch.toString('latin1', 0, 4);
    const len = riff ? ch.readUInt32LE(4) : ch.readUInt32BE(4);
    if (id === 'id3 ' || id === 'ID3 ') { return pos + 8; }
    pos += 8 + len + (len & 1);                   // chunks are word-aligned
  }
  return -1;
}

// Parse the ID3v2 tag whose header sits at `at`, merging the wanted frames
// into `out` (a later tag's frame REPLACES an earlier tag's values for the
// same id). Returns the offset just past the tag, -1 when there is no tag
// header at `at`, or null to bail (unsupported feature, unreadable).
function parseTag(fd, at, wanted, out) {
  const head = Buffer.alloc(10);
  if (fs.readSync(fd, head, 0, 10, at) !== 10) { return -1; }
  if (head.toString('latin1', 0, 3) !== 'ID3') { return -1; }
  const major = head[3];
  if (major < 2 || major > 4) { return null; }
  const flags = head[5];
  if (major === 2 && (flags & 0x40)) { return null; }   // v2.2 whole-tag compression
  const tagSize = syncsafe(head, 6);
  if (tagSize <= 0 || tagSize > MAX_TAG_BYTES) { return null; }
  const end = at + 10 + tagSize;
  let tag = Buffer.alloc(tagSize);
  const got = fs.readSync(fd, tag, 0, tagSize, at + 10);
  if (got < tagSize) { tag = tag.subarray(0, got); }
  // Tag-level unsynchronisation (v2.2/v2.3 — and a v2.4 writer may set it
  // too, meaning every frame is unsynchronised).
  const tagUnsync = (flags & 0x80) !== 0;
  if (tagUnsync && major < 4) { tag = deunsync(tag); }

  let pos = 0;
  if (major > 2 && (flags & 0x40)) {             // extended header
    if (tag.length < pos + 4) { return null; }
    pos += major === 4 ? syncsafe(tag, pos) : 4 + tag.readUInt32BE(pos);
  }
  const headerLen = major === 2 ? 6 : 10;
  const seen = new Set();                        // ids this tag has written into `out`
  while (pos + headerLen <= tag.length) {
    if (tag[pos] === 0x00) { break; }            // padding
    let id, size, frameFlags = 0;
    if (major === 2) {
      id = V22_IDS[tag.toString('latin1', pos, pos + 3)] || tag.toString('latin1', pos, pos + 3);
      size = (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5];
    } else {
      id = tag.toString('latin1', pos, pos + 4);
      size = major === 4 ? syncsafe(tag, pos + 4) : tag.readUInt32BE(pos + 4);
      frameFlags = tag[pos + 9];
    }
    const bodyStart = pos + headerLen;
    if (bodyStart + size > tag.length) { break; } // truncated tag: keep what was read
    if (wanted.has(id)) {
      let body = tag.subarray(bodyStart, bodyStart + size);
      if (major === 3) {
        if (frameFlags & 0xc0) { return null; }   // compressed / encrypted credit frame
        if (frameFlags & 0x20) { body = body.subarray(1); }         // grouping identity byte
      } else if (major === 4) {
        if (frameFlags & 0x0c) { return null; }   // compressed / encrypted credit frame
        if (frameFlags & 0x40) { body = body.subarray(1); }         // grouping identity byte
        if (frameFlags & 0x01) { body = body.subarray(4); }         // data length indicator
        if (tagUnsync || (frameFlags & 0x02)) { body = deunsync(body); }
      }
      if (body.length > MAX_TEXT_FRAME) { return null; }
      const values = decodeText(body);
      if (values === null) { return null; }
      if (!seen.has(id)) { out[id] = []; seen.add(id); }   // replaces an earlier tag's frame
      out[id].push(...values);
    }
    pos = bodyStart + size;
  }
  return end;
}

export function readId3TextFrames(absolutePath, frameIds = CREDIT_FRAME_IDS) {
  const wanted = new Set(frameIds);
  let fd = null;
  try {
    fd = fs.openSync(absolutePath, 'r');
    let at = findTagOffset(fd);
    if (at < 0) { return null; }
    const out = {};
    // Chained tags: some re-taggers append a second ID3v2 (v2.4) right after
    // the original (v2.3). lofty merges them and music-metadata ranks the
    // later version higher, so the later tag's frames win here too.
    for (let i = 0; i < MAX_CHAINED_TAGS && at >= 0; i++) {
      const next = parseTag(fd, at, wanted, out);
      if (next === null) { return null; }
      if (i === 0 && next < 0) { return null; }
      at = next;
    }
    return out;
  } catch (err) {
    // An unreadable file here is one music-metadata just read — worth a
    // line (EACCES / EIO), since the fallback view splits v2.3 names on "/".
    console.error(`Warning: could not read ID3 credit frames of ${absolutePath}: ${err.message}`);
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_e) { /* already closed */ } }
  }
}
