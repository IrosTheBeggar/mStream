// Two ID3v2 tag shapes music-metadata cannot read as the tagger meant them,
// rewritten in memory before the JS scanner hands the file over. (The Rust
// scanner's normalize_id3v2 — rust-parser/src/main.rs — does the same for
// the shapes lofty stumbles on; the two lists overlap only where both
// libraries are wrong, which is shape 2 here.)
//
//   1. ID3v2.2 / v2.3 with the tag-level unsynchronisation flag: the whole
//      body was stuffed (a 0x00 after every 0xFF) and the frame sizes
//      describe the de-stuffed bytes. music-metadata only honours the v2.4
//      per-frame flag, so it walks the stuffed bytes with de-stuffed sizes:
//      everything after the first stuffed byte is misaligned — the embedded
//      picture comes out corrupt and every later frame is lost. lofty reads
//      these correctly.
//   2. ID3v2.4 frame sizes written as plain big-endian numbers instead of
//      syncsafe ones (LAME 3.97-era taggers). music-metadata and lofty both
//      read v2.4 sizes as syncsafe, so a frame over 127 bytes — the picture,
//      usually — is read short and every frame after it is lost. A size
//      byte with its high bit set can only be a plain number; in the
//      ambiguous range the reading that lands on a frame boundary (a frame
//      id, padding, the end of the tag) wins, syncsafe preferred.
//
// normaliseId3v2Tag takes the tag bytes (header + body, `10 + size`) and
// returns them rewritten to the SAME length — the flag cleared and the body
// de-stuffed for 1, the sizes re-encoded for 2, zero padding filling what
// shrank — or null when the tag has neither shape, which is nearly always.
// The caller splices the result over the file's first bytes, so every
// audio offset still holds.

// A tag past this is not something we rewrite (a real tag with several
// embedded pictures is a few MB).
export const MAX_ID3V2_TAG = 64 * 1024 * 1024;

export function id3v2TagSize(head) {
  return ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
}

function syncsafeAt(b, at) {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}

function syncsafeBytes(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

// Reverse ID3v2 unsynchronisation: every 0xFF 0x00 pair is a stuffed 0xFF.
export function deunsync(src) {
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    out[n++] = src[i];
    if (src[i] === 0xff && src[i + 1] === 0x00) { i++; }
  }
  return out.subarray(0, n);
}

// A frame boundary both readers accept at `at`: the end of the tag,
// padding, or a frame id (A–Z / 0–9).
function boundaryOk(data, at) {
  if (at === data.length) { return true; }
  if (at > data.length) { return false; }
  if (data[at] === 0) { return true; }
  if (at + 4 > data.length) { return false; }
  for (let i = at; i < at + 4; i++) {
    const c = data[i];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) { return false; }
  }
  return true;
}

export function normaliseId3v2Tag(tag) {
  if (!tag || tag.length < 10 || tag.toString('latin1', 0, 3) !== 'ID3') { return null; }
  const major = tag[3];
  const flags = tag[5];
  const size = id3v2TagSize(tag);
  if (size === 0 || size > MAX_ID3V2_TAG || tag.length < 10 + size) { return null; }
  if (flags & 0x40) { return null; }              // v2.2 compression / v2.3+ extended header: not ours
  const body = tag.subarray(10, 10 + size);

  // Shape 1: the whole body was stuffed — de-stuff it, clear the flag.
  if ((major === 2 || major === 3) && (flags & 0x80)) {
    const out = Buffer.alloc(10 + size);
    tag.copy(out, 0, 0, 10);
    out[5] = flags & ~0x80;
    deunsync(body).copy(out, 10);
    return out;
  }
  if (major !== 4) { return null; }

  // Shape 2: walk the frame headers; re-encode a size only where the
  // syncsafe reading cannot be right and the plain one is.
  const frames = [];                              // [start, size] in `body`
  let pos = 0;
  let changed = false;
  while (pos + 10 <= body.length && body[pos] !== 0) {
    const ss = syncsafeAt(body, pos + 4);
    const be = body.readUInt32BE(pos + 4);
    let n = ss;
    if (be !== ss) {
      const ssPossible = (body[pos + 4] | body[pos + 5] | body[pos + 6] | body[pos + 7]) < 0x80;
      const okSs = ssPossible && boundaryOk(body, pos + 10 + ss);
      const okBe = boundaryOk(body, pos + 10 + be);
      if (!okSs && okBe && be < (1 << 28)) { n = be; changed = true; }
    }
    if (pos + 10 + n > body.length) {              // an overrunning frame: keep what is there, stop
      frames.push([pos, body.length - pos - 10]);
      break;
    }
    frames.push([pos, n]);
    pos += 10 + n;
  }
  if (!changed) { return null; }
  const out = Buffer.alloc(10 + size);
  tag.copy(out, 0, 0, 10);
  let w = 10;
  for (const [start, n] of frames) {
    body.copy(out, w, start, start + 4);            // id
    syncsafeBytes(n).copy(out, w + 4);              // size, syncsafe
    body.copy(out, w + 8, start + 8, start + 10);   // flags
    body.copy(out, w + 10, start + 10, start + 10 + n);
    w += 10 + n;
  }
  return out;                                     // the rest is zero padding
}
