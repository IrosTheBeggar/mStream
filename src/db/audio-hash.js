/**
 * Dual-hash computation for the scanner.
 *
 *   file_hash  — content hash of the whole file. Below the 25MB
 *                sampling threshold: MD5 of every byte (changes on any
 *                byte change). At/above it: a domain-prefixed sampled
 *                MD5 (three windows + length — see the threshold-hybrid
 *                comment below), so mid-file byte flips OUTSIDE the
 *                windows do not change it. NOT a whole-file integrity
 *                checksum for big files.
 *   audio_hash — same scheme over just the audio payload region (tag
 *                regions stripped). Stable across tag edits.
 *
 * audio_hash is the preferred identity key for user-facing state
 * (stars, play counts, bookmarks, play queue). It is NULL for formats
 * whose audio boundary we can't parse — callers fall back to
 * file_hash in that case.
 *
 * Supported formats (and the per-format tag-stripping rule):
 *
 *   mp3 / aac    — strip ID3v2 prefix, ID3v1 suffix, APEv2 suffix.
 *                  AAC as ADTS follows the same container conventions.
 *   flac         — skip all metadata blocks (everything up to and
 *                  including the one with last_flag set).
 *   wav          — hash only the `data` chunk payload; LIST/INFO, ID3,
 *                  bext, iXML and similar metadata chunks are excluded.
 *   ogg / opus   — walk Ogg pages; hash only the payloads of audio
 *                  pages (pages from the first granule_position > 0
 *                  page onwards). Skips id/comment/setup headers,
 *                  OpusHead, OpusTags. Page headers (which carry
 *                  page_sequence_number — drifts when preceding
 *                  header pages change size) are NOT hashed, only
 *                  payloads.
 *   m4a/m4b/mp4  — hash only the `mdat` atom payload. `moov` (where
 *                  iTunes-style tags live in udta/meta/ilst) is
 *                  excluded automatically.
 *
 * MUST stay byte-identical with rust-parser/src/main.rs. Parity is
 * enforced by test/audio-hash-parity.test.mjs for every supported
 * extension. Any change to the byte-range logic here must land in
 * both implementations simultaneously.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

// ── Core hashers ──────────────────────────────────────────────────────────

function hashStream(filepath, start, end) {
  // end is exclusive. Pass null for "to EOF".
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const opts = { start };
    if (end != null) { opts.end = end - 1; }  // fs.createReadStream end is inclusive
    const stream = fs.createReadStream(filepath, opts);
    stream.on('data', chunk => md5.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(md5.digest('hex')));
  });
}

// Hash the concatenation of a list of byte ranges from a file.
// Ranges are given as [start, end) pairs in file order.
async function hashRanges(filepath, ranges) {
  const md5 = crypto.createHash('md5');
  for (const [start, end] of ranges) {
    if (end <= start) { continue; }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filepath, { start, end: end - 1 });
      stream.on('data', chunk => md5.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  }
  return md5.digest('hex');
}

export function fileHashOf(filepath) {
  return hashStream(filepath, 0, null);
}

// ── Sampled hashing (threshold hybrid) ────────────────────────────────────
//
// Above the threshold, hashing switches from full-content MD5 to a
// sampled MD5 over three windows — 256KB at the start, 512KB centred on
// the middle (the entropy-dense region: intros/outros are where silence
// and fades live), 256KB at the end — plus the total length, all fed
// through a domain prefix that ENCODES the window spec, so any future
// window change can never silently collide with this generation's
// hashes. For audio_hash the windows are positioned in the LOGICAL
// tag-stripped audio stream (the concatenated ranges), which is what
// preserves tag-edit stability: an ID3 resize shifts file offsets but
// not positions within the audio payload. For file_hash the "stream"
// is simply the whole file (one range).
//
// The threshold keys on the hashed stream's OWN length — audio_hash by
// audio-payload length (tag edits can't flip it), file_hash by file
// size — so the scheme choice is deterministic per content. Below the
// threshold nothing changes: full MD5s, byte-identical with every
// existing row. Collision surface above the threshold is the honest
// trade for size-independent scans: ~1MB of sampled content + length,
// with the full-hash floor keeping short (collision-prone) content
// byte-exact. tracks.hash_v stamps which generation a row's hashes
// belong to; equality comparisons are only meaningful within a
// generation.
//
// MUST stay byte-identical with rust-parser/src/main.rs (same windows,
// same domain string, same decimal length encoding) — enforced by
// test/scanner/sampled-hash-vectors.test.mjs and the parity suite.
//
// THE FIVE CONSTANTS BELOW ARE ONE UNIT, pinned to HASH_GENERATION = 2.
// Changing ANY of them (threshold included — it selects which scheme a
// given content gets, so a tune silently splits identities inside a
// generation with no convergence signal) means: bump HASH_GENERATION,
// ship a migration with a rescanEpochId, add a replacement partial
// index (WHERE hash_v < N), and mirror it all in main.rs. Never tune in
// place.
export const SAMPLE_THRESHOLD_DEFAULT = 25 * 1024 * 1024;
export const HASH_GENERATION = 2;
const W_START = 256 * 1024;
const W_MID = 512 * 1024;
const W_END = 256 * 1024;
const SAMPLE_DOMAIN = 'mstream-sampled-v2:256:512:256:';

// Window placement in the logical stream. Integer math only (floor
// division) so Rust u64 arithmetic produces identical offsets. When the
// stream is no larger than the window sum (possible only via a lowered
// threshold — tests use tiny ones), the "sample" is the whole stream in
// one window: still domain-separated from the full scheme, still
// deterministic, and offsets can never go negative or overlap. Above
// the sum, totalLen > W_START+W_MID+W_END guarantees the three windows
// are ordered and disjoint.
function sampleWindows(totalLen) {
  if (totalLen <= W_START + W_MID + W_END) { return [[0, totalLen]]; }
  return [
    [0, W_START],
    [Math.floor(totalLen / 2) - W_MID / 2, W_MID],
    [totalLen - W_END, W_END],
  ];
}

// Feed md5 with `len` bytes starting at `logicalOff` of the
// concatenated ranges' content. Short reads (file truncated mid-scan)
// end the span early — the next scan recomputes and heals. `buf` is
// the caller's scratch buffer, shared across a hash's windows.
async function readLogicalSpan(fd, ranges, logicalOff, len, md5, buf) {
  let skip = logicalOff;
  let remaining = len;
  for (const [start, end] of ranges) {
    if (remaining <= 0) { break; }
    const rlen = end - start;
    if (rlen <= 0) { continue; }
    if (skip >= rlen) { skip -= rlen; continue; }
    let fileOff = start + skip;
    let avail = end - fileOff;
    skip = 0;
    while (avail > 0 && remaining > 0) {
      const n = Math.min(buf.length, avail, remaining);
      const { bytesRead } = await fd.read(buf, 0, n, fileOff);
      if (bytesRead <= 0) { return; }
      md5.update(buf.subarray(0, bytesRead));
      fileOff += bytesRead;
      avail -= bytesRead;
      remaining -= bytesRead;
    }
  }
}

// `fd` is opened (and closed) by computeHashes so both sampled hashes
// share one descriptor — a second open/close is a full round-trip on
// the network mounts big libraries usually live on.
async function sampledHashOverRanges(fd, ranges, totalLen) {
  const md5 = crypto.createHash('md5');
  md5.update(`${SAMPLE_DOMAIN}${totalLen}:`);
  const scratch = Buffer.alloc(64 * 1024);
  for (const [off, len] of sampleWindows(totalLen)) {
    await readLogicalSpan(fd, ranges, off, len, md5, scratch);
  }
  return md5.digest('hex');
}

// ── Extractors: each returns an array of [start, end) ranges, or null
// when the format isn't recognised or no audio payload can be identified.

// MP3 & AAC (ADTS): strip ID3v2 prefix + ID3v1 suffix + APEv2 suffix.
//
// ID3v2 header at offset 0:
//   bytes 0..2: "ID3"
//   byte  5:    flags (bit 0x10 = footer present)
//   bytes 6..9: synchsafe 32-bit tag size (excluding header/footer)
// Audio starts at 10 + tagSize (+ 10 more if footer flag set).
//
// ID3v1 footer: exactly 128 bytes at EOF starting with "TAG".
// APEv2 footer: 32-byte footer with "APETAGEX" signature, optionally
//   followed by an ID3v1 block. Header-present flag in the flags word
//   adds another 32 bytes to the strip size.
async function mp3OrAacAudioRange(filepath, fileSize) {
  if (fileSize < 10) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const head = Buffer.alloc(10);
    await fd.read(head, 0, 10, 0);

    let start = 0;
    if (head[0] === 0x49 /*I*/ && head[1] === 0x44 /*D*/ && head[2] === 0x33 /*3*/) {
      const tagSize = ((head[6] & 0x7f) << 21)
                    | ((head[7] & 0x7f) << 14)
                    | ((head[8] & 0x7f) << 7)
                    |  (head[9] & 0x7f);
      start = 10 + tagSize;
      if (head[5] & 0x10) { start += 10; }  // footer flag
    }

    let end = fileSize;
    if (fileSize >= 128) {
      const trailer = Buffer.alloc(3);
      await fd.read(trailer, 0, 3, fileSize - 128);
      if (trailer[0] === 0x54 && trailer[1] === 0x41 && trailer[2] === 0x47) {
        end = fileSize - 128;
      }
    }

    // APEv2 probe: signature at (end - 32).
    if (end >= 32) {
      const apeHdr = Buffer.alloc(32);
      await fd.read(apeHdr, 0, 32, end - 32);
      if (apeHdr.toString('latin1', 0, 8) === 'APETAGEX') {
        const sz = apeHdr.readUInt32LE(12);
        const flags = apeHdr.readUInt32LE(20);
        const hasHeader = !!(flags & 0x80000000);
        end -= sz + (hasHeader ? 32 : 0);
      }
    }

    if (start >= end) { return null; }
    return [[start, end]];
  } finally {
    await fd.close();
  }
}

// FLAC: 4-byte "fLaC" magic followed by a chain of metadata blocks.
// Each block header: 1 byte [last_flag:1 | block_type:7] + 3 bytes big-endian length.
// Audio frames start immediately after the block whose last_flag is 1.
async function flacAudioRange(filepath, fileSize) {
  if (fileSize < 4) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await fd.read(magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'fLaC') { return null; }

    let cursor = 4;
    const blkHdr = Buffer.alloc(4);
    while (cursor + 4 <= fileSize) {
      await fd.read(blkHdr, 0, 4, cursor);
      const last = (blkHdr[0] & 0x80) !== 0;
      const len = (blkHdr[1] << 16) | (blkHdr[2] << 8) | blkHdr[3];
      cursor += 4 + len;
      if (last) { break; }
      if (cursor > fileSize) { return null; }
    }
    if (cursor >= fileSize) { return null; }
    return [[cursor, fileSize]];
  } finally {
    await fd.close();
  }
}

// WAV (RIFF/WAVE): 12-byte outer header, then chunks. Each chunk:
//   4-byte ASCII id + 4-byte LE size + payload (padded to even length).
// We walk the chunk chain and return the payload of the `data` chunk.
// LIST/INFO, ID3, bext, iXML, and similar metadata chunks are ignored.
async function wavAudioRange(filepath, fileSize) {
  if (fileSize < 12) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const hdr = Buffer.alloc(12);
    await fd.read(hdr, 0, 12, 0);
    if (hdr.toString('latin1', 0, 4) !== 'RIFF') { return null; }
    if (hdr.toString('latin1', 8, 12) !== 'WAVE') { return null; }

    let cursor = 12;
    const chunkHdr = Buffer.alloc(8);
    while (cursor + 8 <= fileSize) {
      await fd.read(chunkHdr, 0, 8, cursor);
      const id   = chunkHdr.toString('latin1', 0, 4);
      const size = chunkHdr.readUInt32LE(4);
      const payloadStart = cursor + 8;
      const payloadEnd   = Math.min(payloadStart + size, fileSize);
      if (id === 'data') { return [[payloadStart, payloadEnd]]; }
      // WAV chunks are word-aligned: odd-length payloads have a pad byte.
      cursor = payloadStart + size + (size & 1);
    }
    return null;
  } finally {
    await fd.close();
  }
}

// Ogg (Vorbis, Opus, FLAC-in-Ogg): logical stream of Ogg pages, each with
// a 27-byte fixed header + variable segment table + payload.
//
// Tag payloads live in "header" packets that occur before the first
// audio packet. Those header packets terminate with granule_position = 0
// (they produce no samples); continuation pages for multi-page headers
// use granule_position = -1 ("no packets finish on this page").
//
// Rule: skip every page until the first one with granule_position > 0
// (the first page whose audio packet finishes within it). From there to
// EOF, hash PAYLOADS ONLY — page headers carry page_sequence_number and
// CRC, both of which drift when preceding header pages change size.
async function oggAudioRange(filepath, fileSize) {
  if (fileSize < 27) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const ranges = [];
    let audioStarted = false;
    let cursor = 0;
    const pageHdr = Buffer.alloc(27);

    while (cursor + 27 <= fileSize) {
      await fd.read(pageHdr, 0, 27, cursor);
      if (pageHdr.toString('latin1', 0, 4) !== 'OggS') { break; }
      const granule = pageHdr.readBigInt64LE(6);
      const pageSegments = pageHdr[26];
      const segTable = Buffer.alloc(pageSegments);
      await fd.read(segTable, 0, pageSegments, cursor + 27);
      let payloadSize = 0;
      for (let i = 0; i < pageSegments; i++) { payloadSize += segTable[i]; }
      const payloadStart = cursor + 27 + pageSegments;
      const payloadEnd   = payloadStart + payloadSize;
      if (payloadEnd > fileSize) { return null; }  // truncated file

      if (audioStarted) {
        ranges.push([payloadStart, payloadEnd]);
      } else if (granule > 0n) {
        audioStarted = true;
        ranges.push([payloadStart, payloadEnd]);
      }
      // granule === 0n or -1n → pre-audio header region, skip.

      cursor = payloadEnd;
    }

    return ranges.length > 0 ? ranges : null;
  } finally {
    await fd.close();
  }
}

// MP4 / M4A / M4B: ISO base media atom tree. Each atom is
//   4-byte BE size + 4-byte type + payload.
// Size == 1 means a 64-bit extended size immediately follows.
// Size == 0 means "extends to end of file" (rare, used for streaming).
//
// Audio samples live in the `mdat` atom; tags live in
// `moov/udta/meta/ilst` (among other places inside `moov`). Hashing
// just `mdat` keeps audio_hash stable across any metadata-only edit.
//
// Some files have multiple `mdat` atoms (fragmented MP4). We hash all
// of them in file order; the concatenation stays stable under tag edits.
async function mp4AudioRange(filepath, fileSize) {
  if (fileSize < 8) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const ranges = [];
    let cursor = 0;
    const atomHdr = Buffer.alloc(16);  // room for extended 64-bit size

    while (cursor + 8 <= fileSize) {
      await fd.read(atomHdr, 0, Math.min(16, fileSize - cursor), cursor);
      const sz32 = atomHdr.readUInt32BE(0);
      const type = atomHdr.toString('latin1', 4, 8);

      let headerLen;
      let atomEnd;
      if (sz32 === 1) {
        // 64-bit extended size at bytes 8..15.
        const szHi = atomHdr.readUInt32BE(8);
        const szLo = atomHdr.readUInt32BE(12);
        const sz64 = szHi * 0x100000000 + szLo;
        headerLen = 16;
        atomEnd = cursor + sz64;
      } else if (sz32 === 0) {
        headerLen = 8;
        atomEnd = fileSize;  // extends to EOF
      } else {
        headerLen = 8;
        atomEnd = cursor + sz32;
      }
      // Malformed-size guards. `atomEnd < cursor + headerLen` catches
      // size fields smaller than the header itself (pathological). Empty
      // payload (atomEnd === cursor + headerLen, e.g. an 8-byte `free`
      // padding atom) is legitimate and we just advance past it.
      if (atomEnd > fileSize || atomEnd < cursor + headerLen) { break; }

      if (type === 'mdat' && atomEnd > cursor + headerLen) {
        ranges.push([cursor + headerLen, atomEnd]);
      }
      cursor = atomEnd;
    }

    return ranges.length > 0 ? ranges : null;
  } finally {
    await fd.close();
  }
}

// ── Public entry point ────────────────────────────────────────────────────

const EXTRACTORS = {
  mp3:  mp3OrAacAudioRange,
  aac:  mp3OrAacAudioRange,
  flac: flacAudioRange,
  wav:  wavAudioRange,
  ogg:  oggAudioRange,
  opus: oggAudioRange,
  m4a:  mp4AudioRange,
  m4b:  mp4AudioRange,
  mp4:  mp4AudioRange,
};

/**
 * Compute both hashes for a file in a single pass.
 *
 * @param {string} filepath
 * @returns {Promise<{fileHash: string, audioHash: string|null, format: string|null}>}
 */
export async function computeHashes(filepath, { sampleThreshold = SAMPLE_THRESHOLD_DEFAULT } = {}) {
  // Clamp to >= 1: a zero threshold would sample EVERY file. The scan
  // payload's Joi schema rejects 0 outright, and the Rust engine clamps
  // identically (ScanConfig::sample_threshold) — the engines must never
  // diverge on the same config.
  const threshold = Math.max(1, sampleThreshold);
  const stat = await fsp.stat(filepath);
  const fileSize = stat.size;

  // Ranges first — every extractor reads only headers, so this is cheap
  // and lets BOTH hashes decide full-vs-sampled before any payload read.
  const ext = path.extname(filepath).slice(1).toLowerCase();
  const extractor = EXTRACTORS[ext];
  let ranges = null;
  let extractorFailed = false;
  if (extractor) {
    try { ranges = await extractor(filepath, fileSize); }
    catch { extractorFailed = true; }
    if (ranges && !ranges.length) { ranges = null; }
  }

  // Per-hash independent thresholds: file_hash by file size, audio_hash
  // by audio-payload length (see the sampled-hashing comment above). A
  // huge-tag file can therefore sample one and not the other — each
  // hash's choice is deterministic for its own content. When either
  // hash samples, ONE descriptor is opened here and shared by both
  // sampled reads (each open is a round-trip on network mounts).
  const audioLen = ranges
    ? ranges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0)
    : 0;
  const fileSampled = fileSize >= threshold;
  const audioSampled = audioLen >= threshold;
  const fd = (fileSampled || audioSampled) ? await fsp.open(filepath, 'r') : null;
  try {
    const fileHash = fileSampled
      ? await sampledHashOverRanges(fd, [[0, fileSize]], fileSize)
      : await hashStream(filepath, 0, null);

    if (!extractor) { return { fileHash, audioHash: null, format: null }; }
    if (extractorFailed || !ranges) { return { fileHash, audioHash: null, format: ext }; }

    const audioHash = audioSampled
      ? await sampledHashOverRanges(fd, ranges, audioLen)
      : await hashRanges(filepath, ranges);
    return { fileHash, audioHash, format: ext };
  } finally {
    if (fd) { await fd.close(); }
  }
}

/**
 * Convenience: pick the best identity key for a track.
 * Preference: audio_hash (stable across tag edits), fall back to file_hash
 * (what older rows use and what formats we don't parse yet emit).
 */
export function canonicalHash(track) {
  if (!track) { return null; }
  return track.audio_hash || track.file_hash || null;
}
