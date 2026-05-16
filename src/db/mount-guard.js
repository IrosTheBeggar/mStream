// Mount Guard — a small file dropped in each library root after a
// successful scan, used to detect when the underlying storage has
// silently gone away (NAS unmounted, USB drive disconnected, Docker
// volume mount missing).
//
// On the next scan start the scanner pre-checks for this file. If it's
// missing AND the library already has tracks in the DB, the scanner
// aborts the scan with a structured `scanAborted` event instead of
// running `deleteOldTracks` and wiping every track row — which is the
// "your library suddenly looks empty, delete everything" failure mode
// the guard exists to prevent.
//
// The check is a presence test only — content is human-readable
// explainer text so a user who stumbles on it understands what it's
// for and doesn't delete it.
//
// Three callers share this module:
//   • src/db/scanner.mjs            — JS fallback scanner pre/post-scan
//   • src/util/admin.js             — admin reset endpoint
//   • rust-parser/src/main.rs       — mirrors the constants inline (Rust
//                                      can't import this module, so the
//                                      filename + content are duplicated
//                                      there; keep both in sync if you
//                                      ever change the wording)

import fs from 'fs';
import path from 'path';

export const SENTINEL_FILENAME = '.mstream.md';

export const SENTINEL_CONTENT = `# mStream — Mount Guard

This file protects your mStream database from being wiped when your
music drive or network share is not mounted.

How it works:
- mStream writes this file after every successful library scan.
- Before each new scan, mStream checks that this file is present.
- If it's missing AND your library already has tracks, the scan is
  aborted and your DB is left untouched — preventing an unmounted
  NAS or unplugged drive from being treated as "delete everything".

Do NOT delete this file. It is safe to leave in your music root.

If you intentionally emptied your library and want the next scan to
proceed, POST to /api/v1/admin/directory/reset-sentinel (or just
re-create this file by any means).
`;

export function sentinelPath(libraryRoot) {
  return path.join(libraryRoot, SENTINEL_FILENAME);
}

export function sentinelExists(libraryRoot) {
  try { return fs.existsSync(sentinelPath(libraryRoot)); }
  catch (_) { return false; }
}

/**
 * Write the sentinel to the library root. Returns true on success.
 * On failure (read-only filesystem, EACCES, ENOENT root missing)
 * returns the Error so the caller can log it without throwing —
 * a sentinel-write failure should never abort a scan that
 * otherwise succeeded.
 */
export function writeSentinel(libraryRoot) {
  try {
    fs.writeFileSync(sentinelPath(libraryRoot), SENTINEL_CONTENT, 'utf8');
    return true;
  } catch (err) {
    return err;
  }
}
