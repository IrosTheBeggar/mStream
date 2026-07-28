// Walk/sweep ignore rules, shared by the JS scanner's directory walk
// (src/db/scanner.mjs) and the stale-track sweep (src/db/orphan-cleanup.js).
// The Rust scanner carries the same rules (is_ignored_dir_name /
// is_dot_entry / is_ignored_rel_path in rust-parser/src/main.rs); the two
// implementations MUST stay in lockstep — the sweep applies the same
// predicate as the walk so that rows indexed before a rule existed (or
// under a different flag setting) converge OUT of the index on the next
// scan instead of surviving forever as "file still exists on disk" rows.

// Hardcoded directory blocklist — always on, no config, matched
// case-insensitively against each directory NAME. NAS recycle bins
// ($RECYCLE.BIN, #recycle, @Recycle), NAS snapshot dirs
// (@Recently-Snapshot, #snapshot), VCS/sync metadata (.git, .stfolder,
// .stversions) and OS artifacts (lost+found, System Volume Information)
// hold deleted/duplicate/system files, never library music — indexing a
// recycle bin resurrects every deleted track in the browse UI. Entries
// are stored lowercase; look up with a lowercased name.
export const IGNORED_DIR_NAMES = new Set([
  '$recycle.bin',
  '#recycle',
  '@recycle',
  '@recently-snapshot',
  '#snapshot',
  '.git',
  'lost+found',
  '.stfolder',
  '.stversions',
  'system volume information',
]);

export function isIgnoredDirName(name) {
  return IGNORED_DIR_NAMES.has(name.toLowerCase());
}

// A "dot entry" is hidden-by-convention: a SINGLE leading dot. Names
// starting with '..' ('..WeirdAlbum', '...Trilogy') are ordinary names —
// albums really do start with ellipses. Mirrors Navidrome's isDotEntry.
export function isDotEntry(name) {
  return name.startsWith('.') && !name.startsWith('..');
}

// Sweep-side arm of the walk's ignore rules, applied to a DB row's
// library-relative path (forward slashes, as normalized at insert). A row
// is ignored when ANY directory segment is blocklisted or (flag-dependent)
// dot-hidden, or when the filename itself is dot-hidden — every segment is
// considered, not just the basename, because the walk prunes whole
// subtrees. The blocklist deliberately does NOT apply to the filename
// segment: it is a directory rule, and a FILE named '#recycle' is walked
// like any other (its extension decides). Rel paths never contain the
// library root itself, so the never-prune-the-scan-root rule holds here by
// construction.
export function isIgnoredRelPath(relPath, { ignoreDotFiles = true, ignoreDotFolders = true } = {}) {
  const segs = relPath.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '') { continue; }
    if (i === segs.length - 1) {
      if (ignoreDotFiles && isDotEntry(seg)) { return true; }
    } else if (isIgnoredDirName(seg) || (ignoreDotFolders && isDotEntry(seg))) {
      return true;
    }
  }
  return false;
}
