// File-system probe for "seed an existing torrent" — the admin
// UI card lets an operator drop .torrent files onto the page, and
// for each one we check whether the torrent's contents already
// live under one of the configured libraries. When a match is
// found, the route hands the torrent to the daemon paused=false
// so it can recheck the files and start seeding without
// re-downloading.
//
// What "match" means here:
//   - Every file the torrent declares in info.files (or the single
//     info.length file) is present on disk under <vpathRoot>/
//     <info.name>/<f.path>, AND its byte size matches f.length.
//   - BEP 47 padding files are excluded from the tally entirely.
//     Hybrid v1+v2 torrents (libtorrent 2.x / qBittorrent 4.4+
//     creators) interleave `.pad/NNN` entries flagged attr='p'
//     between the real files to align piece boundaries — clients
//     never write them to disk, so counting them as "missing"
//     made every hybrid torrent structurally unmatchable.
//   - We deliberately do NOT hash the contents. The daemon does
//     SHA-1 verification when it starts a seed; double-hashing
//     here would burn a lot of CPU for no behavioural gain. The
//     trade-off: a file with the right size but wrong content
//     passes our check and surfaces as "errored" in the admin
//     Torrents list after the daemon's recheck. That's a
//     visible failure mode, not data loss.
//
// We try ONE candidate root per vpath: <vpathRoot>/<info.name>.
// The "no top dir" variant (files extracted directly into the
// vpath root) would require asking the daemon to rename the
// torrent's root, which isn't worth the complexity for v1. If
// the operator extracted into the vpath root, they can move the
// files into a <info.name>/ subdir and try again.
//
// Pure module — no DB, no daemon RPC, no config. Tests in
// test/torrent-seed-existing.test.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { findField } from './bencode.js';

// Cap the missing-files array we return to the caller. A torrent
// with 5000 files where none match would otherwise produce a
// 5000-entry array; the UI only renders the first few and the
// rest are noise.
const _MISSING_REPORT_CAP = 20;

// BEP 47: a file entry's `attr` is a byte string of single-character
// flags; 'p' marks a padding file the client never writes to disk.
// The name-prefix check catches the pre-BEP-47 BitComet convention
// (`_____padding_file_N_...`), which carries no attr flag but is
// treated as padding by libtorrent-based clients all the same.
function _isPadFile(relPath, attr) {
  if (attr.includes('p')) { return true; }
  const leaf = relPath[relPath.length - 1] || '';
  return leaf.startsWith('_____padding_file');
}

// A path segment we're willing to join under the candidate root.
// f.path comes straight out of attacker-controlled metainfo; a '..'
// (or separator-bearing) segment would walk the stat probe outside
// the library and turn this check into an exists-with-size oracle
// for arbitrary server paths.
function _isSafeSegment(seg) {
  return seg.length > 0 && seg !== '.' && seg !== '..'
    && !seg.includes('/') && !seg.includes('\\') && !seg.includes('\0');
}

/**
 * Pull the file list out of an info dict, normalised into
 *   [{ relPath: ['dir', 'file'], length: 12345, unsafe: false }, ...]
 *
 * BEP 47 padding entries are dropped here, so `filesInTorrent.length`
 * is the count of REAL files — the denominator the caller reports.
 * `unsafe` marks entries whose path segments must never be joined
 * onto the candidate root (traversal shapes); the caller counts them
 * as missing without statting.
 *
 * For single-file torrents (info.length present, no info.files),
 * the list has one entry whose relPath is just [info.name]. The
 * caller can treat both cases uniformly when joining onto a
 * candidate root.
 */
function _enumerateFiles(infoDict) {
  const topName = infoDict.name
    ? Buffer.from(infoDict.name).toString('utf8')
    : '';
  if (Array.isArray(infoDict.files)) {
    const files = [];
    for (const f of infoDict.files) {
      const relPath = (f.path || []).map(b => Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
      const attr = f.attr
        ? (Buffer.isBuffer(f.attr) ? f.attr.toString('utf8') : String(f.attr))
        : '';
      if (_isPadFile(relPath, attr)) { continue; }
      files.push({
        relPath,
        length: typeof f.length === 'number' ? f.length : 0,
        unsafe: relPath.length === 0 || !relPath.every(_isSafeSegment),
      });
    }
    return { filesInTorrent: files, topName, isMulti: true };
  }
  // Single-file: filename IS info.name; the "rel path" is the
  // filename itself. The caller's candidateRoot already includes
  // info.name, so the per-file join becomes <candidateRoot> +
  // [info.name] which would double up — handle by emitting an
  // empty relPath. checkFilesExist below documents this.
  return {
    // unsafe: false — the empty relPath is the documented single-file
    // shape (candidateRoot IS the file); topName safety is checked by
    // checkFilesExist before the root is ever joined.
    filesInTorrent: [{ relPath: [], length: typeof infoDict.length === 'number' ? infoDict.length : 0, unsafe: false }],
    topName,
    isMulti: false,
  };
}

// Stat a single file and score it against the expected length.
async function _checkOne(absPath, expectedLength) {
  let stat;
  try { stat = await fs.stat(absPath); }
  catch { return { exists: false, sizeMatch: false }; }
  if (!stat.isFile()) { return { exists: true, sizeMatch: false }; }
  return { exists: true, sizeMatch: stat.size === expectedLength };
}

/**
 * Check whether a torrent's files already live under a vpath.
 *
 * @param {Buffer} metainfo  Raw .torrent file bytes.
 * @param {string} vpathRoot Absolute, mStream-side directory of the
 *                            library to check (e.g. `lib.root_path`).
 * @returns {Promise<{
 *   allMatch:    boolean,
 *   matched:     number,
 *   total:       number,
 *   missing:     string[],    // forward-slash rel paths; capped
 *   matchedRoot: string|null, // on-disk path; null when allMatch=false
 *   partialRoot: string|null, // on-disk path of the directory where the
 *                              // partial files live; populated when
 *                              // matched > 0 AND allMatch === false.
 *                              // The user-facing UI surfaces this so
 *                              // the operator can re-submit with a
 *                              // pre-filled directoryName to let the
 *                              // daemon hash the existing files and
 *                              // download only what's missing.
 *   topName:     string,
 *   isMulti:     boolean,
 * }>}
 *
 * Throws when the .torrent bytes don't have a usable info dict —
 * callers map this to outcome:'invalid_torrent'. Every other path
 * (filesystem error on individual stats, partial match) returns
 * a structured result with appropriate counters.
 */
export async function checkFilesExist(metainfo, vpathRoot) {
  const info = findField(metainfo, 'info');
  if (!info.found || !info.raw) {
    throw new Error('no info dict in torrent file');
  }
  const { filesInTorrent, topName, isMulti } = _enumerateFiles(info.value);

  // Candidate root: <vpathRoot>/<info.name>. For single-file
  // torrents info.name IS the filename, and _enumerateFiles emits
  // relPath=[] so the join below resolves to just candidateRoot.
  // For multi-file, info.name is the top directory and the file
  // entries hold the within-torrent rel paths.
  //
  // info.name is attacker-controlled too (BEP-3 says it SHOULD be a
  // single segment, but nothing enforces that) — a separator- or
  // '..'-bearing name would relocate the whole probe outside the
  // library, so an unsafe topName makes every file unmatchable.
  const topNameSafe = !topName || _isSafeSegment(topName);
  const candidateRoot = topName && topNameSafe
    ? path.join(vpathRoot, topName)
    : vpathRoot;

  let matchedCount = 0;
  const missing = [];
  for (const f of filesInTorrent) {
    if (!topNameSafe || f.unsafe) {
      if (missing.length < _MISSING_REPORT_CAP) {
        missing.push(f.relPath.length > 0 ? f.relPath.join('/') : topName);
      }
      continue;
    }
    const absPath = f.relPath.length > 0
      ? path.join(candidateRoot, ...f.relPath)
      : candidateRoot;
    const r = await _checkOne(absPath, f.length);
    if (r.exists && r.sizeMatch) {
      matchedCount++;
    } else if (missing.length < _MISSING_REPORT_CAP) {
      missing.push(f.relPath.length > 0 ? f.relPath.join('/') : topName);
    }
  }

  const total = filesInTorrent.length;
  const allMatch = matchedCount === total && total > 0;
  // partialRoot mirrors matchedRoot but for the >0 && !allMatch case:
  // the operator's torrent has SOME files in this candidate dir, and
  // the UI wants to point at that directory so the user can pre-fill
  // the daemon's save-path on a follow-up /torrent/add. We intentionally
  // do NOT set matchedRoot for partials — existing admin-route consumers
  // rely on `matchedRoot != null ⇒ all files matched ⇒ daemon-add succeeded`.
  const partialRoot = !allMatch && matchedCount > 0 ? candidateRoot : null;
  return {
    allMatch,
    matched:     matchedCount,
    total,
    missing,
    matchedRoot: allMatch ? candidateRoot : null,
    partialRoot,
    topName,
    isMulti,
  };
}
